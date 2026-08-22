// Represente une salle de jeu : joueurs, reglages, phase et etat courant.
// IMPORTANT : publicState() ne revele les roles que des joueurs ELIMINES
// (ou de tous a la fin). Les secrets (role/mot en vie, protection du Gardien,
// enquete du Devin) ne sont jamais diffuses publiquement.
//
// Machine a etats :
//   LOBBY -> REVEAL -> INDICES <-> VOTE -> (WHITE_GUESS) -> ... -> ENDED
//
// Camps : bad = imposteur+mister_white ; good = civil+gardien+devin ;
//         fou = neutre (gagne s'il est elimine au vote).

import { defaultSetup, drawPair, assignRoles, countAvailablePairs, shuffle } from "./gameLogic.js";
import { validateSetup } from "./validation.js";
import { pairKey, THEMES } from "./words.js";

const BAD_ROLES = ["imposteur", "mister_white"];
const GOOD_ROLES = ["civil", "gardien", "devin"];
const CIVIL_LIKE = ["civil", "gardien", "devin", "fou"];

// Prenoms d'apparence humaine pour le joueur IA (il doit se fondre dans la liste).
const AI_NAMES = ["Léa", "Hugo", "Manon", "Nathan", "Chloé", "Lucas", "Jade", "Enzo", "Camille", "Sacha", "Inès", "Noah", "Zoé", "Tom", "Anaïs", "Ryan", "Maël", "Lina"];

// Noms de code anonymes (mode IA) : en partie, chacun est un animal, pour qu'on
// ne puisse pas identifier l'IA par appel des pseudos. Vrais noms reveles a la fin.
const ALIASES = [
  "🦊 Renard", "🦉 Hibou", "🐺 Loup", "🐻 Ours", "🦌 Cerf", "🦅 Aigle",
  "🐬 Dauphin", "🦁 Lion", "🐯 Tigre", "🐨 Koala", "🦝 Raton", "🦔 Hérisson",
  "🐸 Grenouille", "🐢 Tortue", "🦎 Lézard", "🦩 Flamant", "🦈 Requin", "🦫 Castor",
];

function normalizeWord(s) {
  return (s ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

export class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map(); // id -> { id, name, connected, alive }
    this.phase = "LOBBY";
    this.customized = false;
    this.settings = { imposteurs: 1, misterWhite: 0, difficulte: null, themes: [], fou: 0, gardien: 0, devin: 0, ai: 0, camouflage: "facile" };
    this.aiId = null; // id du joueur IA (virtuel), s'il est active

    this.playedPairs = new Set();
    this.resetRound();
  }

  resetRound() {
    this.roles = {}; // id -> { role, word }  (SECRET)
    this.aliases = {}; // id -> nom de code anonyme (mode IA)
    this.currentPair = null;
    this.firstSpeaker = null;
    this.order = [];
    this.round = 0;
    this.currentClueOrder = [];
    this.cluePointer = 0;
    this.clues = [];
    this.votes = new Map();
    this.tieRevote = false;
    this.lastStartId = null;
    this.revealed = new Set();
    this.pendingWhiteId = null;
    this.protectedId = null; // cible protegee par le Gardien (SECRET, ce tour)
    this.devinUsedBy = new Set(); // devins ayant deja enquete
    this.winner = null;
    this.endReason = null;
  }

  // --- Lobby -------------------------------------------------------------

  addPlayer(id, name) {
    this.players.set(id, { id, name, connected: true, alive: true });
    this.applyDefaultsIfNeeded();
  }

  removePlayer(id) {
    this.players.delete(id);
    this.applyDefaultsIfNeeded();
  }

  isHost(id) {
    return this.hostId === id;
  }

  applyDefaultsIfNeeded() {
    if (this.customized) return;
    const d = defaultSetup(this.players.size);
    this.settings.imposteurs = d.imposteurs;
    this.settings.misterWhite = d.misterWhite;
  }

  updateSettings({ imposteurs, misterWhite, difficulte, themes, fou, gardien, devin, ai, camouflage }) {
    if (typeof imposteurs === "number") this.settings.imposteurs = Math.max(0, Math.floor(imposteurs));
    if (typeof misterWhite === "number") this.settings.misterWhite = Math.max(0, Math.floor(misterWhite));
    if (typeof fou === "number") this.settings.fou = Math.min(1, Math.max(0, Math.floor(fou)));
    if (typeof gardien === "number") this.settings.gardien = Math.min(1, Math.max(0, Math.floor(gardien)));
    if (typeof devin === "number") this.settings.devin = Math.min(1, Math.max(0, Math.floor(devin)));
    if (difficulte !== undefined) this.settings.difficulte = difficulte || null;
    if (Array.isArray(themes)) this.settings.themes = themes.filter((t) => THEMES.includes(t));
    if (typeof ai === "number") {
      this.settings.ai = Math.min(1, Math.max(0, Math.floor(ai)));
      this.syncAIPlayer();
    }
    if (camouflage === "facile" || camouflage === "difficile") this.settings.camouflage = camouflage;
    this.customized = true;
  }

  // --- Joueur IA (virtuel) ----------------------------------------------

  humanCount() {
    return [...this.players.values()].filter((p) => !p.isAI).length;
  }

  // Mode anonyme actif des qu'un joueur IA est present (empeche l'appel des pseudos).
  isAnonymous() {
    return !!this.settings.ai;
  }

  // Nom a afficher : alias anonyme en partie, sinon le vrai pseudo.
  displayName(id) {
    if (this.isAnonymous() && this.aliases[id]) return this.aliases[id];
    return this.players.get(id)?.name ?? "?";
  }

  pickAIName() {
    const used = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    const pool = AI_NAMES.filter((n) => !used.has(n.toLowerCase()));
    const from = pool.length ? pool : AI_NAMES;
    return from[Math.floor(Math.random() * from.length)];
  }

  // Ajoute/retire le joueur IA selon le reglage (uniquement dans le lobby).
  // L'IA est un joueur comme les autres ; son statut d'IA reste SECRET (jamais
  // dans publicState) et n'est revele qu'a la fin (revealPayload).
  syncAIPlayer() {
    if (this.phase !== "LOBBY") return;
    if (this.settings.ai && !this.aiId) {
      const id = "ai:" + this.code;
      this.players.set(id, { id, name: this.pickAIName(), connected: true, alive: true, isAI: true });
      this.aiId = id;
      this.applyDefaultsIfNeeded();
    } else if (!this.settings.ai && this.aiId) {
      this.players.delete(this.aiId);
      this.aiId = null;
      this.applyDefaultsIfNeeded();
    }
  }

  // --- Lancement d'une manche -------------------------------------------

  startGame() {
    const players = this.players.size;
    const s = this.settings;
    const setup = {
      imposteurs: s.imposteurs,
      misterWhite: s.misterWhite,
      fou: s.fou,
      gardien: s.gardien,
      devin: s.devin,
    };

    const check = validateSetup({ players, ...setup });
    if (!check.valid) return { ok: false, error: check.errors[0] };

    const pair = drawPair({ difficulte: s.difficulte, themes: s.themes, exclude: this.playedPairs });
    if (!pair) return { ok: false, error: "Aucune paire de mots disponible pour ces réglages." };

    this.resetRound();
    this.order = [...this.players.keys()];
    for (const p of this.players.values()) p.alive = true;

    // Noms de code anonymes (mode IA) : un alias par joueur, tire au hasard.
    if (this.isAnonymous()) {
      const pool = shuffle(ALIASES);
      this.order.forEach((id, i) => {
        this.aliases[id] = pool[i] ?? `Joueur ${i + 1}`;
      });
    }

    const { roles, firstSpeaker } = assignRoles(this.order, setup, pair);
    this.currentPair = pair;
    this.playedPairs.add(pairKey(pair));
    this.roles = roles;
    this.firstSpeaker = firstSpeaker;
    this.phase = "REVEAL";

    return { ok: true };
  }

  // --- Phase INDICES -----------------------------------------------------

  aliveIds() {
    return [...this.players.keys()].filter((id) => this.players.get(id)?.alive);
  }

  nextAliveAfter(id) {
    const pos = this.order.indexOf(id);
    for (let k = 1; k <= this.order.length; k++) {
      const nid = this.order[(pos + k) % this.order.length];
      if (this.players.get(nid)?.alive) return nid;
    }
    return id;
  }

  beginClueRound() {
    this.round++;

    let startId;
    if (this.round === 1 && this.players.get(this.firstSpeaker)?.alive) {
      startId = this.firstSpeaker;
    } else if (this.lastStartId) {
      startId = this.nextAliveAfter(this.lastStartId);
    } else {
      startId = this.aliveIds()[0];
    }
    this.lastStartId = startId;

    const startPos = this.order.indexOf(startId);
    const ring = [];
    for (let k = 0; k < this.order.length; k++) {
      const id = this.order[(startPos + k) % this.order.length];
      if (this.players.get(id)?.alive) ring.push(id);
    }
    this.currentClueOrder = ring;
    this.cluePointer = 0;
    this.phase = "INDICES";
  }

  enterVote() {
    this.phase = "VOTE";
    this.votes = new Map();
    this.tieRevote = false;
    this.protectedId = null; // la protection se rejoue chaque tour de vote
  }

  submitClue(playerId, text) {
    if (this.phase !== "INDICES") return { ok: false, error: "Ce n'est pas la phase d'indices." };
    const expected = this.currentClueOrder[this.cluePointer];
    if (playerId !== expected) return { ok: false, error: "Ce n'est pas ton tour." };

    const clean = (text ?? "").toString().trim().slice(0, 60);
    if (!clean) return { ok: false, error: "Ton indice est vide." };

    this.clues.push({ round: this.round, playerId, name: this.players.get(playerId).name, text: clean });
    this.cluePointer++;

    if (this.cluePointer >= this.currentClueOrder.length) {
      this.enterVote();
      return { ok: true, phaseChanged: "VOTE" };
    }
    return { ok: true };
  }

  // --- Pouvoir du Gardien : protection ----------------------------------

  setProtection(gardienId, targetId) {
    if (this.phase !== "VOTE") return { ok: false, error: "La protection se choisit pendant le vote." };
    if (this.roles[gardienId]?.role !== "gardien") return { ok: false, error: "Tu n'es pas le Gardien." };
    if (!this.players.get(gardienId)?.alive) return { ok: false, error: "Tu es éliminé." };
    if (!this.players.get(targetId)?.alive) return { ok: false, error: "Cible invalide." };
    if (targetId === gardienId) return { ok: false, error: "Tu ne peux pas te protéger toi-même." };
    this.protectedId = targetId;
    return { ok: true };
  }

  // --- Pouvoir du Devin : enquete (1 fois) ------------------------------

  devinCheck(devinId, targetId) {
    if (this.phase !== "INDICES" && this.phase !== "VOTE") return { ok: false, error: "Pas maintenant." };
    if (this.roles[devinId]?.role !== "devin") return { ok: false, error: "Tu n'es pas le Devin." };
    if (!this.players.get(devinId)?.alive) return { ok: false, error: "Tu es éliminé." };
    if (this.devinUsedBy.has(devinId)) return { ok: false, error: "Tu as déjà utilisé ton pouvoir." };
    if (!this.players.get(targetId)?.alive) return { ok: false, error: "Cible invalide." };
    if (targetId === devinId) return { ok: false, error: "Choisis un autre joueur." };

    this.devinUsedBy.add(devinId);
    const isTraitor = BAD_ROLES.includes(this.roles[targetId]?.role);
    return { ok: true, private: true, targetName: this.displayName(targetId), isTraitor };
  }

  // --- Phase VOTE --------------------------------------------------------

  castVote(voterId, targetId) {
    if (this.phase !== "VOTE") return { ok: false, error: "Ce n'est pas la phase de vote." };
    if (!this.players.get(voterId)?.alive) return { ok: false, error: "Tu ne peux pas voter." };
    if (!this.players.get(targetId)?.alive) return { ok: false, error: "Cible invalide." };
    if (voterId === targetId) return { ok: false, error: "Tu ne peux pas voter pour toi." };

    this.votes.set(voterId, targetId);

    if (this.votes.size >= this.aliveIds().length) {
      return this.resolveVotes();
    }
    return { ok: true, progress: true };
  }

  namedTally(tally) {
    return Object.entries(tally)
      .map(([id, votes]) => ({ name: this.displayName(id), votes }))
      .sort((a, b) => b.votes - a.votes);
  }

  resolveVotes() {
    const tally = {};
    for (const t of this.votes.values()) tally[t] = (tally[t] || 0) + 1;

    let max = 0;
    let leaders = [];
    for (const [id, c] of Object.entries(tally)) {
      if (c > max) {
        max = c;
        leaders = [id];
      } else if (c === max) {
        leaders.push(id);
      }
    }

    let eliminatedId;
    let wasTie = false;
    if (leaders.length > 1) {
      if (!this.tieRevote) {
        this.tieRevote = true;
        this.votes = new Map();
        return { ok: true, type: "tie", tied: leaders.map((id) => this.displayName(id)), revote: true };
      }
      eliminatedId = leaders[Math.floor(Math.random() * leaders.length)];
      wasTie = true;
    } else {
      eliminatedId = leaders[0];
    }

    // Protection du Gardien : la cible la plus visee est sauvee.
    if (this.protectedId && eliminatedId === this.protectedId) {
      const savedName = this.displayName(eliminatedId);
      this.protectedId = null;
      this.beginClueRound();
      return { ok: true, type: "protected", name: savedName, nextPhase: "INDICES" };
    }

    return this.eliminate(eliminatedId, tally, wasTie);
  }

  eliminate(id, tally, wasTie) {
    const p = this.players.get(id);
    p.alive = false;
    this.revealed.add(id);
    const role = this.roles[id].role;

    const result = {
      ok: true,
      type: "elimination",
      eliminatedId: id,
      name: this.displayName(id),
      role,
      wasTie,
      tally: this.namedTally(tally),
    };

    // Le Fou gagne s'il se fait eliminer au vote.
    if (role === "fou") {
      this.endGame("fou", `${p.name}, le Fou, s'est fait éliminer : il gagne !`);
      return { ...result, ended: true, winner: this.winner, reason: this.endReason };
    }

    // Mister White demasque : il tente de deviner le mot.
    if (role === "mister_white") {
      this.phase = "WHITE_GUESS";
      this.pendingWhiteId = id;
      return { ...result, needsWhiteGuess: true };
    }

    return { ...result, ...this.advanceAfterElimination() };
  }

  // --- Cas special Mister White -----------------------------------------

  whiteGuess(playerId, guess) {
    if (this.phase !== "WHITE_GUESS" || playerId !== this.pendingWhiteId) {
      return { ok: false, error: "Ce n'est pas à toi de deviner." };
    }
    this.pendingWhiteId = null;
    const correct = normalizeWord(guess) === normalizeWord(this.currentPair.civil);

    if (correct) {
      this.endGame("traitres", `Mister White a deviné le mot : « ${this.currentPair.civil} » !`);
      return { ok: true, type: "white_result", correct: true, guess, ended: true, winner: this.winner, reason: this.endReason };
    }
    const after = this.advanceAfterElimination();
    return { ok: true, type: "white_result", correct: false, guess, ...after };
  }

  // --- Conditions de victoire / progression -----------------------------

  checkWin() {
    const alive = this.aliveIds();
    const bad = alive.filter((id) => BAD_ROLES.includes(this.roles[id]?.role)).length;
    const good = alive.filter((id) => GOOD_ROLES.includes(this.roles[id]?.role)).length;

    if (bad === 0) {
      return { ended: true, winner: "civils", reason: "Tous les imposteurs ont été démasqués." };
    }
    if (bad >= good) {
      return { ended: true, winner: "traitres", reason: "Les imposteurs ont atteint la parité : ils l'emportent." };
    }
    return { ended: false };
  }

  advanceAfterElimination() {
    const w = this.checkWin();
    if (w.ended) {
      this.endGame(w.winner, w.reason);
      return { ended: true, winner: w.winner, reason: w.reason };
    }
    this.beginClueRound();
    return { ended: false, nextPhase: "INDICES" };
  }

  endGame(winner, reason) {
    this.phase = "ENDED";
    this.winner = winner;
    this.endReason = reason;
    for (const id of this.players.keys()) this.revealed.add(id);
  }

  playAgain() {
    this.resetRound();
    this.phase = "LOBBY";
    this.applyDefaultsIfNeeded();
  }

  // --- Deconnexion en cours de partie -----------------------------------

  handleLeaveDuringGame(id) {
    const p = this.players.get(id);
    if (!p) return {};
    p.connected = false;
    p.alive = false;
    if (this.protectedId === id) this.protectedId = null;

    const idx = this.currentClueOrder.indexOf(id);
    if (idx !== -1) {
      this.currentClueOrder.splice(idx, 1);
      if (idx < this.cluePointer) this.cluePointer--;
    }
    this.votes.delete(id);

    if (this.phase === "INDICES" || this.phase === "VOTE") {
      const w = this.checkWin();
      if (w.ended) {
        this.endGame(w.winner, w.reason);
        return { ended: true, winner: w.winner, reason: w.reason };
      }
    }
    if (this.phase === "INDICES" && this.cluePointer >= this.currentClueOrder.length && this.currentClueOrder.length > 0) {
      this.enterVote();
      return { phaseChanged: "VOTE" };
    }
    if (this.phase === "VOTE" && this.votes.size >= this.aliveIds().length && this.aliveIds().length > 0) {
      return this.resolveVotes();
    }
    return {};
  }

  // --- Etat diffusable ---------------------------------------------------

  publicState() {
    const n = this.players.size;
    const s = this.settings;
    const validation = validateSetup({
      players: n,
      imposteurs: s.imposteurs,
      misterWhite: s.misterWhite,
      fou: s.fou,
      gardien: s.gardien,
      devin: s.devin,
    });
    const availablePairs = countAvailablePairs({ difficulte: s.difficulte, themes: s.themes });
    const turnId = this.phase === "INDICES" ? this.currentClueOrder[this.cluePointer] ?? null : null;
    const anon = this.isAnonymous();

    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      anonymous: anon,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        // Mode anonyme : alias en partie, nom masque (null) au lobby.
        name: anon ? this.aliases[p.id] ?? null : p.name,
        connected: p.connected,
        alive: p.alive,
        role: this.revealed.has(p.id) ? this.roles[p.id]?.role ?? null : null,
      })),
      settings: { ...s },
      allThemes: THEMES,
      counts: {
        players: n,
        civils: validation.civils,
        bad: validation.bad,
        imposteurs: s.imposteurs,
        misterWhite: s.misterWhite,
        fou: s.fou,
        gardien: s.gardien,
        devin: s.devin,
        availablePairs,
      },
      validation: { valid: validation.valid, errors: validation.errors },
      firstSpeakerName: this.firstSpeaker ? this.displayName(this.firstSpeaker) : null,
      turnId,
      turnName: turnId ? this.displayName(turnId) : null,
      clues: anon ? this.clues.map((c) => ({ ...c, name: this.aliases[c.playerId] ?? c.name })) : this.clues,
      voters: [...this.votes.keys()],
      aliveCount: this.aliveIds().length,
      pendingWhiteId: this.pendingWhiteId,
      winner: this.winner,
      endReason: this.endReason,
    };
  }

  revealPayload() {
    return {
      winner: this.winner,
      reason: this.endReason,
      pair: this.currentPair,
      aiName: this.aiId ? this.players.get(this.aiId)?.name ?? null : null,
      roles: [...this.players.entries()].map(([id, p]) => ({
        id,
        name: p.name,
        alias: this.aliases[id] ?? null,
        role: this.roles[id]?.role ?? null,
        word: this.roles[id]?.word ?? null,
        isAI: !!p.isAI,
      })),
    };
  }
}
