// Cerveau du joueur IA (l'« imposteur IA »). Appelle Google Gemini cote serveur
// pour generer des indices, des votes et une reponse de Mister White, en imitant
// un joueur humain. La cle reste cote serveur (GEMINI_API_KEY), jamais exposee.
//
// Tolerant aux pannes : si la cle manque ou si l'API echoue, chaque fonction
// retombe sur un comportement de secours pour que la partie ne se bloque JAMAIS.

import { GoogleGenAI } from "@google/genai";

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const genai = KEY ? new GoogleGenAI({ apiKey: KEY }) : null;

export function aiConfigured() {
  return !!genai;
}

// Diagnostic : essaie plusieurs formes de requete pour identifier le champ qui
// fait echouer l'appel (jamais la cle exposee).
export async function selfTest() {
  if (!genai) return { reason: "GEMINI_API_KEY absente" };
  try {
    const res = await genai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: "Donne un indice d'un seul mot sur « chat », sans dire le mot." }] }],
      config: { systemInstruction: "Tu joues au jeu de l'imposteur. Réponds par un seul mot.", maxOutputTokens: 512, temperature: 1.0 },
    });
    return { ok: true, model: MODEL, sample: (res.text || "").trim().slice(0, 60) };
  } catch (e) {
    return { ok: false, model: MODEL, error: String(e?.message || e).replace(/\s+/g, " ").slice(0, 200) };
  }
}

// Un appel Gemini court, sans « thinking » (reponses rapides). Renvoie une
// chaine, ou null en cas d'echec (l'appelant gere le repli).
async function ask(system, user, maxTokens = 512) {
  if (!genai) return null;
  try {
    const res = await genai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: user }] }],
      // Pas de thinkingConfig (rejete par Gemini 3). maxOutputTokens genereux car
      // le modele consomme des tokens de reflexion avant de repondre.
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        temperature: 1.0,
      },
    });
    return (res.text || "").trim();
  } catch (e) {
    console.error("[AI] Gemini:", e?.message || e);
    return null;
  }
}

const FALLBACK_CLUES = ["assez courant", "un peu spécial", "classique", "du quotidien", "ça dépend", "connu", "banal", "bof", "commun"];

function cluesText(room) {
  const list = room.clues.map((c) => `${c.name}: ${c.text}`);
  return list.length ? list.join("\n") : "(aucun indice pour l'instant)";
}

// Voix du joueur : une personnalite STABLE par partie (derivee du code de salle),
// pour que le bot ait un style coherent et humain au fil de ses indices.
const PERSONAS = [
  "tu écris très court et sec, souvent un seul mot, tout en minuscules",
  "tu fonctionnes par associations d'idées un peu perso",
  "tu glisses parfois une petite vanne ou un jeu de mots léger",
  "tu restes prudent·e, tes indices sont plutôt vagues",
  "tu balances 2-3 mots sur un ton oral et relâché",
  "tu es direct·e, un peu je-m'en-foutiste",
];

function personaFor(room) {
  const s = room.code || "x";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PERSONAS[h % PERSONAS.length];
}

function cleanClue(s) {
  if (!s) return "";
  return s
    .split("\n")[0]
    .trim()
    .replace(/^["'«»\-\s]+|["'«».\s]+$/g, "")
    .slice(0, 60)
    .trim();
}

// --- Indice ---------------------------------------------------------------

export async function generateClue(room) {
  const info = room.roles[room.aiId] || {};
  let roleLine;
  if (info.role === "mister_white") {
    roleLine =
      "Tu n'as AUCUN mot secret (ne le dis jamais). Devine l'ambiance à partir des indices déjà donnés et lâche un indice plausible et assez vague, qui te fait passer pour quelqu'un qui connaît le mot.";
  } else if (info.role === "imposteur") {
    roleLine = `Ton mot est « ${info.word} », mais tu es sans doute l'imposteur (ton mot diffère peut-être de celui des autres). Donne un indice qui colle à TON mot ET qui pourrait aussi coller au leur — reste sûr, appuie-toi sur ce que les autres ont dit pour te fondre. Ne te trahis pas par un détail trop précis.`;
  } else {
    roleLine = `Ton mot est « ${info.word} ». Prouve subtilement que tu le connais, sans le rendre trop facile pour l'imposteur : ni trop évident, ni trop vague.`;
  }

  const persona = personaFor(room);
  const system = `Tu joues au jeu de l'imposteur (type Undercover) en français, entre potes, sur ton téléphone. Tu es un vrai joueur humain — ${persona}.

RÈGLES (comme quelqu'un qui tape vite) :
- UN SEUL indice, très court : 1 à 3 mots. Jamais de phrase, jamais d'explication.
- Ton oral et familier, minuscules ok, pas de ponctuation finale.
- Ne sois pas trop parfait·e : un humain balance ce qui lui vient, il n'optimise pas.
- N'écris jamais le mot secret. Ne répète pas un indice déjà donné, ni le mot exact d'un autre joueur.
- Ne révèle JAMAIS que tu es une IA.

Réponds UNIQUEMENT par l'indice — aucun guillemet, aucun nom, aucune phrase autour.`;
  const user = `${roleLine}\n\nIndices déjà donnés :\n${cluesText(room)}\n\nÀ toi, ton indice :`;

  const out = cleanClue(await ask(system, user, 512));
  return out || FALLBACK_CLUES[Math.floor(Math.random() * FALLBACK_CLUES.length)];
}

// --- Vote -----------------------------------------------------------------

function norm(s) {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
}

export async function chooseVote(room) {
  const info = room.roles[room.aiId] || {};
  const candidates = room.aliveIds().filter((id) => id !== room.aiId);
  if (candidates.length === 0) return room.aiId; // ne devrait pas arriver

  const bad = ["imposteur", "mister_white"].includes(info.role);
  const goal = bad
    ? "Tu es dans le camp des imposteurs. Vote pour éliminer un joueur qui a l'air d'un civil sûr de lui, afin de détourner les soupçons de toi."
    : "Tu es un civil. Vote pour le joueur dont l'indice sonne le plus faux ou le plus vague (probable imposteur).";

  const names = candidates.map((id) => room.players.get(id)?.name);
  const system = `Tu joues au jeu de l'imposteur en français. Tu dois voter pour UN joueur à éliminer. ${goal} Réponds UNIQUEMENT par le prénom exact de l'un des joueurs proposés, rien d'autre.`;
  const user = `Joueurs (choisis-en un) : ${names.join(", ")}\n\nIndices donnés :\n${cluesText(room)}\n\nPour qui votes-tu ?`;

  const ans = (await ask(system, user, 256)) || "";
  let target = candidates.find((id) => norm(room.players.get(id)?.name) === norm(ans));
  if (!target && ans) target = candidates.find((id) => norm(ans).includes(norm(room.players.get(id)?.name)));
  if (!target) target = candidates[Math.floor(Math.random() * candidates.length)];
  return target;
}

// --- Mister White : deviner le mot ---------------------------------------

export async function guessWord(room) {
  const system =
    "Tu es Mister White dans un jeu de l'imposteur. Devine le MOT commun des civils à partir des indices donnés. Réponds UNIQUEMENT par un seul mot, sans phrase.";
  const user = `Indices donnés :\n${cluesText(room)}\n\nLe mot des civils est probablement :`;
  let out = (await ask(system, user, 128)) || "";
  out = (out.split(/\s+/)[0] || "").replace(/[^\p{L}\-]/gu, "");
  if (!out) {
    const texts = room.clues.map((c) => c.text).filter(Boolean);
    out = texts.length ? texts[texts.length - 1].split(/\s+/)[0] : "inconnu";
  }
  return out;
}
