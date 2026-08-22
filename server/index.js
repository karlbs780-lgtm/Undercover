// Serveur autoritaire : Express (sert le front) + Socket.IO (temps reel).
// Chaque joueur ne recoit que ce qu'il a le droit de voir. Les roles/mots
// secrets ne transitent que dans des messages prives ("your_role").

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { Room } from "./Room.js";
import { generateClue, chooseVote, guessWord, aiConfigured } from "./ai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(join(__dirname, "..", "public")));

/** @type {Map<string, Room>} */
const rooms = new Map();

// --- Utilitaires ---------------------------------------------------------

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const n = (name ?? "").toString().trim().slice(0, 20);
  return n || "Joueur";
}

function broadcast(room) {
  io.to(room.code).emit("state", room.publicState());
}

// Envoie a chaque joueur sa carte privee (role + mot).
function dealRoles(room) {
  for (const [pid, info] of Object.entries(room.roles)) {
    io.to(pid).emit("your_role", {
      role: info.role,
      word: info.word,
      isFirstSpeaker: pid === room.firstSpeaker,
    });
  }
}

// Interprete le resultat d'une action de jeu et emet les evenements adequats.
function applyResult(room, result) {
  if (!result) return;
  if (result.type === "tie") {
    io.to(room.code).emit("vote_tie", { tied: result.tied });
  }
  if (result.type === "elimination") {
    io.to(room.code).emit("elimination", {
      eliminatedId: result.eliminatedId,
      name: result.name,
      role: result.role,
      wasTie: result.wasTie,
      tally: result.tally,
    });
  }
  if (result.type === "white_result") {
    io.to(room.code).emit("white_result", { correct: result.correct, guess: result.guess });
  }
  if (result.type === "protected") {
    io.to(room.code).emit("protected", { name: result.name });
  }
  if (result.ended) {
    io.to(room.code).emit("game_over", room.revealPayload());
  }
  broadcast(room);
  driveAI(room);
}

// --- Joueur IA : joue automatiquement son tour (indice / vote / white) ----
// Un seul planificateur par salle (room.aiTimer + garde room.aiPending) : on
// reflechit apres CHAQUE changement d'etat pour voir si c'est a l'IA d'agir.

function aiDelay(min = 1500, max = 3400) {
  return min + Math.floor(Math.random() * (max - min));
}

function scheduleAI(room, fn) {
  room.aiPending = true;
  clearTimeout(room.aiTimer);
  room.aiTimer = setTimeout(async () => {
    try {
      await fn();
    } catch (e) {
      console.error("[AI] action:", e?.message || e);
    } finally {
      room.aiPending = false;
      driveAI(room);
    }
  }, aiDelay());
}

function driveAI(room) {
  if (!room || !room.aiId || room.aiPending) return;
  const ai = room.players.get(room.aiId);
  if (!ai) return;

  // Mister White demasque : l'IA doit deviner le mot (meme si elle vient d'etre
  // eliminee — donc on teste ce cas AVANT le garde "en vie").
  if (room.phase === "WHITE_GUESS" && room.pendingWhiteId === room.aiId) {
    scheduleAI(room, async () => {
      const guess = await guessWord(room);
      applyResult(room, room.whiteGuess(room.aiId, guess));
    });
    return;
  }

  if (!ai.alive) return;

  // Indice : c'est au tour de l'IA de parler.
  if (room.phase === "INDICES" && room.currentClueOrder[room.cluePointer] === room.aiId) {
    scheduleAI(room, async () => {
      const text = await generateClue(room);
      const res = room.submitClue(room.aiId, text);
      if (res.ok) broadcast(room);
    });
    return;
  }

  // Vote : l'IA n'a pas encore vote.
  if (room.phase === "VOTE" && !room.votes.has(room.aiId)) {
    scheduleAI(room, async () => {
      const targetId = await chooseVote(room);
      applyResult(room, room.castVote(room.aiId, targetId));
    });
    return;
  }
}

// --- Socket.IO -----------------------------------------------------------

io.on("connection", (socket) => {
  const getRoom = () => rooms.get(socket.data.code);
  const requireHost = (cb) => {
    const room = getRoom();
    if (!room) {
      cb?.({ ok: false, error: "Salle introuvable." });
      return null;
    }
    if (!room.isHost(socket.id)) {
      cb?.({ ok: false, error: "Seul l'hôte peut faire cela." });
      return null;
    }
    return room;
  };

  socket.on("create_room", ({ name } = {}, cb) => {
    const code = generateCode();
    const room = new Room(code, socket.id);
    rooms.set(code, room);
    room.addPlayer(socket.id, cleanName(name));
    socket.join(code);
    socket.data.code = code;
    cb?.({ ok: true, code, playerId: socket.id, state: room.publicState() });
    broadcast(room);
  });

  socket.on("join_room", ({ code, name } = {}, cb) => {
    const key = (code ?? "").toString().trim().toUpperCase();
    const room = rooms.get(key);
    if (!room) return cb?.({ ok: false, error: "Aucune partie avec ce code." });
    if (room.phase !== "LOBBY") return cb?.({ ok: false, error: "La partie a déjà commencé." });
    room.addPlayer(socket.id, cleanName(name));
    socket.join(key);
    socket.data.code = key;
    cb?.({ ok: true, code: key, playerId: socket.id, state: room.publicState() });
    broadcast(room);
  });

  socket.on("update_settings", (settings = {}, cb) => {
    const room = requireHost(cb);
    if (!room) return;
    room.updateSettings(settings);
    broadcast(room);
    cb?.({ ok: true });
  });

  socket.on("start_game", (_ = {}, cb) => {
    const room = requireHost(cb);
    if (!room) return;
    const res = room.startGame();
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    dealRoles(room);
    io.to(room.code).emit("game_started", { firstSpeaker: room.firstSpeaker ? room.displayName(room.firstSpeaker) : null });
    broadcast(room);
    cb?.({ ok: true });
  });

  socket.on("begin_clues", (_ = {}, cb) => {
    const room = requireHost(cb);
    if (!room) return;
    if (room.phase !== "REVEAL") return cb?.({ ok: false, error: "Impossible maintenant." });
    room.beginClueRound();
    broadcast(room);
    driveAI(room);
    cb?.({ ok: true });
  });

  socket.on("submit_clue", ({ text } = {}, cb) => {
    const room = getRoom();
    if (!room) return cb?.({ ok: false, error: "Salle introuvable." });
    const res = room.submitClue(socket.id, text);
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    broadcast(room);
    driveAI(room);
    cb?.({ ok: true });
  });

  socket.on("cast_vote", ({ targetId } = {}, cb) => {
    const room = getRoom();
    if (!room) return cb?.({ ok: false, error: "Salle introuvable." });
    const res = room.castVote(socket.id, targetId);
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    applyResult(room, res); // resout le vote si tout le monde a vote
    cb?.({ ok: true });
  });

  socket.on("white_guess", ({ guess } = {}, cb) => {
    const room = getRoom();
    if (!room) return cb?.({ ok: false, error: "Salle introuvable." });
    const res = room.whiteGuess(socket.id, guess);
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    applyResult(room, res);
    cb?.({ ok: true });
  });

  socket.on("set_protection", ({ targetId } = {}, cb) => {
    const room = getRoom();
    if (!room) return cb?.({ ok: false, error: "Salle introuvable." });
    const res = room.setProtection(socket.id, targetId);
    cb?.(res); // protection secrète : aucune diffusion
  });

  socket.on("devin_check", ({ targetId } = {}, cb) => {
    const room = getRoom();
    if (!room) return cb?.({ ok: false, error: "Salle introuvable." });
    const res = room.devinCheck(socket.id, targetId);
    if (!res.ok) return cb?.(res);
    io.to(socket.id).emit("devin_result", { targetName: res.targetName, isTraitor: res.isTraitor });
    cb?.({ ok: true });
  });

  socket.on("play_again", (_ = {}, cb) => {
    const room = requireHost(cb);
    if (!room) return;
    room.playAgain();
    broadcast(room);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = getRoom();
    if (!room) return;

    // Ne jamais confier l'hote au joueur IA (il n'a pas de socket).
    const nextHumanHost = () =>
      [...room.players.keys()].find((id) => !room.players.get(id).isAI && room.players.get(id).connected) ??
      [...room.players.keys()].find((id) => !room.players.get(id).isAI) ??
      null;

    if (room.phase === "LOBBY" || room.phase === "ENDED") {
      room.removePlayer(socket.id);
      if (room.humanCount() === 0) {
        clearTimeout(room.aiTimer);
        rooms.delete(room.code);
        return;
      }
      if (room.hostId === socket.id) room.hostId = nextHumanHost();
      broadcast(room);
      return;
    }

    // En pleine partie : reconciliation (peut declencher vote/elimination/fin).
    const res = room.handleLeaveDuringGame(socket.id);
    if (room.hostId === socket.id) {
      room.hostId = nextHumanHost() ?? room.hostId;
    }
    applyResult(room, res);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Devine tête — serveur sur http://localhost:${PORT}`);
  console.log(
    aiConfigured()
      ? "[AI] Joueur IA actif (Gemini configuré)."
      : "[AI] GEMINI_API_KEY absente — le joueur IA jouera en mode secours (indices/votes basiques)."
  );
});
