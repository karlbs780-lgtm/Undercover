// Represente une salle de jeu : joueurs, reglages, phase et etat courant.
// IMPORTANT : publicState() ne revele les roles que des joueurs ELIMINES
// (ou de tous a la fin). Le role/mot d'un joueur en vie n'est envoye qu'a lui,
// en prive, via "your_role".
//
// Machine a etats :
//   LOBBY -> REVEAL -> INDICES <-> VOTE -> (WHITE_GUESS) -> ... -> ENDED
//                         ^__________________________________|
//                              (tant qu'aucun camp n'a gagne)

import { defaultSetup, drawPair, assignRoles, countAvailablePairs } from "./gameLogic.js";
import { validateSetup } from "./validation.js";
import { pairKey, THEMES } from "./words.js";

function normalizeWord(s) {
  return (s ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // enleve les accents
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
    this.settings = { imposteurs: 1, misterWhite: 0, difficulte: null, themes: [] };

    this.playedPairs = new Set(); // anti-repetition entre manches
    this.resetRound();
  }

  // Remet a zero l'etat d'une manche (garde joueurs, reglages, playedPairs).
  resetRound() {
    this.roles = {}; // id -> { role, word }  (SECRET)
    this.currentPair = null;
    this.firstSpeaker = null;
    this.order = []; // ordre stable des joueurs (ordre d'arrivee)
    this.round = 0;
    this.currentClueOrder = []; // ids vivants, dans l'ordre de parole du tour
    this.cluePointer = 0;
    this.clues = []; // journal public { round, playerId, name, text }
    this.votes = new Map(); // voterId -> targetId (tour de vote courant)
    this.tieRevote = false;
    this.lastStartId = null;
    this.revealed = new Set(); // ids dont le role est public (elimines)
    this.pendingWhiteId = null; // Mister White en train de deviner
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

  updateSettings({ imposteurs, misterWhite, difficulte, themes }) {
    if (typeof imposteurs === "number") this.settings.imposteurs = Math.max(0, Math.floor(imposteurs));
    if (typeof misterWhite === "number") this.settings.misterWhite = Math.max(0, Math.floor(misterWhite));
    if (difficulte !== undefined) this.settings.difficulte = difficulte || null;
    if (Array.isArray(themes)) {
      this.settings.themes = themes.filter((t) => THEMES.includes(t)); // ne garde que des themes connus
    }
    this.customized = true;
  }

  // --- Lancement d'une manche -------------------------------------------

  startGame() {
    const players = this.players.size;
    const setup = { imposteurs: this.settings.imposteurs, misterWhite: this.settings.misterWhite };

    const check = validateSetup({ players, ...setup });
    if (!check.valid) return { ok: false, error: check.errors[0] };

    const pair = drawPair({
      difficulte: this.settings.difficulte,
      themes: this.settings.themes,
      exclude: this.playedPairs,
    });
    if (!pair) return { ok: false, error: "Aucune paire de mots disponible pour ces réglages." };

    this.resetRound();
    this.order = [...this.players.keys()];
    for (const p of this.players.values()) p.alive = true;

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

  submitClue(playerId, text) {
    if (this.phase !== "INDICES") return { ok: false, error: "Ce n'est pas la phase d'indices." };
    const expected = this.currentClueOrder[this.cluePointer];
    if (playerId !== expected) return { ok: false, error: "Ce n'est pas ton tour." };

    const clean = (text ?? "").toString().trim().slice(0, 60);
    if (!clean) return { ok: false, error: "Ton indice est vide." };

    this.clues.push({ round: this.round, playerId, name: this.players.get(playerId).name, text: clean });
    this.cluePointer++;

    if (this.cluePointer >= this.currentClueOrder.length) {
      this.phase = "VOTE";
      this.votes = new Map();
      this.tieRevote = false;
      return { ok: true, phaseChanged: "VOTE" };
    }
    return { ok: true };
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
      .map(([id, votes]) => ({ name: this.players.get(id)?.name ?? "?", votes }))
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

    if (leaders.length > 1) {
      if (!this.tieRevote) {
        // Premiere egalite : on revote.
        this.tieRevote = true;
        this.votes = new Map();
        return { ok: true, type: "tie", tied: leaders.map((id) => this.players.get(id)?.name), revote: true };
      }
      // Deuxieme egalite consecutive : on tranche au hasard pour avancer.
      const pick = leaders[Math.floor(Math.random() * leaders.length)];
      return this.eliminate(pick, tally, true);
    }
    return this.eliminate(leaders[0], tally, false);
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
      name: p.name,
      role,
      wasTie,
      tally: this.namedTally(tally),
    };

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
    const traitres = alive.filter((id) => this.roles[id]?.role !== "civil").length;
    const civils = alive.filter((id) => this.roles[id]?.role === "civil").length;

    if (traitres === 0) {
      return { ended: true, winner: "civils", reason: "Tous les imposteurs ont été démasqués." };
    }
    if (traitres >= civils) {
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

    const idx = this.currentClueOrder.indexOf(id);
    if (idx !== -1) {
      this.currentClueOrder.splice(idx, 1);
      if (idx < this.cluePointer) this.cluePointer--;
    }
    this.votes.delete(id);

    // Un depart peut faire basculer la victoire (ex: le seul imposteur part).
    if (this.phase === "INDICES" || this.phase === "VOTE") {
      const w = this.checkWin();
      if (w.ended) {
        this.endGame(w.winner, w.reason);
        return { ended: true, winner: w.winner, reason: w.reason };
      }
    }
    if (this.phase === "INDICES" && this.cluePointer >= this.currentClueOrder.length && this.currentClueOrder.length > 0) {
      this.phase = "VOTE";
      this.votes = new Map();
      this.tieRevote = false;
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
    const validation = validateSetup({ players: n, imposteurs: s.imposteurs, misterWhite: s.misterWhite });
    const availablePairs = countAvailablePairs({ difficulte: s.difficulte, themes: s.themes });
    const turnId = this.phase === "INDICES" ? this.currentClueOrder[this.cluePointer] ?? null : null;

    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        alive: p.alive,
        role: this.revealed.has(p.id) ? this.roles[p.id]?.role ?? null : null,
      })),
      settings: { ...s },
      allThemes: THEMES,
      counts: { players: n, civils: validation.civils, traitres: validation.traitres, availablePairs },
      validation: { valid: validation.valid, errors: validation.errors },
      firstSpeakerName: this.firstSpeaker ? this.players.get(this.firstSpeaker)?.name ?? null : null,
      // Etat de jeu (public, sans secret)
      turnId,
      turnName: turnId ? this.players.get(turnId)?.name ?? null : null,
      clues: this.clues,
      voters: [...this.votes.keys()],
      aliveCount: this.aliveIds().length,
      pendingWhiteId: this.pendingWhiteId,
      winner: this.winner,
      endReason: this.endReason,
    };
  }

  // Revelation complete de fin de partie (roles + mots).
  revealPayload() {
    return {
      winner: this.winner,
      reason: this.endReason,
      pair: this.currentPair,
      roles: [...this.players.entries()].map(([id, p]) => ({
        id,
        name: p.name,
        role: this.roles[id]?.role ?? null,
        word: this.roles[id]?.word ?? null,
      })),
    };
  }
}
