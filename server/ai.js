// Cerveau du joueur IA (l'« imposteur IA »). Appelle Google Gemini cote serveur
// pour generer des indices, des votes et une reponse de Mister White, en imitant
// un joueur humain. La cle reste cote serveur (GEMINI_API_KEY), jamais exposee.
//
// Tolerant aux pannes : si la cle manque ou si l'API echoue, chaque fonction
// retombe sur un comportement de secours pour que la partie ne se bloque JAMAIS.

import { GoogleGenAI } from "@google/genai";

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const genai = KEY ? new GoogleGenAI({ apiKey: KEY }) : null;

export function aiConfigured() {
  return !!genai;
}

// Diagnostic : fait UN vrai appel Gemini minimal et renvoie le resultat ou
// l'erreur (jamais la cle). Sert a comprendre pourquoi le bot retombe en secours.
export async function selfTest() {
  if (!genai) return { ok: false, reason: "GEMINI_API_KEY absente" };
  try {
    const res = await genai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: "Dis juste : OK" }] }],
      config: { systemInstruction: "Réponds en un seul mot.", maxOutputTokens: 16, temperature: 1.0, thinkingConfig: { thinkingBudget: 0 } },
    });
    return { ok: true, model: MODEL, text: (res.text || "").trim(), finishReason: res?.candidates?.[0]?.finishReason ?? null };
  } catch (e) {
    return { ok: false, model: MODEL, error: String(e?.message || e).slice(0, 400) };
  }
}

// Un appel Gemini court, sans « thinking » (reponses rapides). Renvoie une
// chaine, ou null en cas d'echec (l'appelant gere le repli).
async function ask(system, user, maxTokens = 48) {
  if (!genai) return null;
  try {
    const res = await genai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        temperature: 1.0,
        thinkingConfig: { thinkingBudget: 0 },
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
  const me = room.players.get(room.aiId);
  const info = room.roles[room.aiId] || {};
  let roleLine;
  if (info.role === "mister_white") {
    roleLine =
      "Tu n'as AUCUN mot secret (mais ne le dis jamais). Déduis un indice crédible à partir des indices déjà donnés, et reste assez vague pour ne pas te faire démasquer.";
  } else if (info.role === "imposteur") {
    roleLine = `Ton mot secret est « ${info.word} ». Tu es peut-être l'imposteur (ton mot diffère peut-être de celui des autres) : donne un indice lié à TON mot, mais reste prudent et pas trop précis.`;
  } else {
    roleLine = `Ton mot secret est « ${info.word} ». Donne un indice lié à ce mot, sans jamais écrire le mot lui-même, ni trop évident ni trop vague.`;
  }

  const system = `Tu joues au jeu de l'imposteur (type Undercover) en français, avec des amis. Tu es « ${me?.name} ». À ton tour, tu donnes UN SEUL indice très court (1 à 4 mots) sur ton mot, exactement comme un vrai joueur humain : naturel, relâché, parfois une petite faute de frappe. Ne révèle JAMAIS que tu es une IA. Réponds UNIQUEMENT par l'indice, sans guillemets, sans ton nom, sans phrase autour.`;
  const user = `${roleLine}\n\nIndices déjà donnés :\n${cluesText(room)}\n\nTon indice (max 4 mots) :`;

  const out = cleanClue(await ask(system, user, 40));
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

  const ans = (await ask(system, user, 12)) || "";
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
  let out = (await ask(system, user, 10)) || "";
  out = (out.split(/\s+/)[0] || "").replace(/[^\p{L}\-]/gu, "");
  if (!out) {
    const texts = room.clues.map((c) => c.text).filter(Boolean);
    out = texts.length ? texts[texts.length - 1].split(/\s+/)[0] : "inconnu";
  }
  return out;
}
