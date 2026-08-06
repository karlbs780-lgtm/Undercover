// Serveur autoritaire : Express (sert le front) + Socket.IO (temps reel).
// Chaque joueur ne recoit que ce qu'il a le droit de voir. Les roles/mots
// secrets ne transitent que dans des messages prives ("your_role").

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { Room } from "./Room.js";

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
    io.to(room.code).emit("game_started", { firstSpeaker: room.players.get(room.firstSpeaker)?.name ?? null });
    broadcast(room);
    cb?.({ ok: true });
  });

  socket.on("begin_clues", (_ = {}, cb) => {
    const room = requireHost(cb);
    if (!room) return;
    if (room.phase !== "REVEAL") return cb?.({ ok: false, error: "Impossible maintenant." });
    room.beginClueRound();
    broadcast(room);
    cb?.({ ok: true });
  });

  socket.on("submit_clue", ({ text } = {}, cb) => {
    const room = getRoom();
    if (!room) return cb?.({ ok: false, error: "Salle introuvable." });
    const res = room.submitClue(socket.id, text);
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    broadcast(room);
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

    if (room.phase === "LOBBY" || room.phase === "ENDED") {
      room.removePlayer(socket.id);
      if (room.players.size === 0) {
        rooms.delete(room.code);
        return;
      }
      if (room.hostId === socket.id) room.hostId = [...room.players.keys()][0];
      broadcast(room);
      return;
    }

    // En pleine partie : reconciliation (peut declencher vote/elimination/fin).
    const res = room.handleLeaveDuringGame(socket.id);
    if (room.hostId === socket.id && room.players.size > 0) {
      room.hostId = [...room.players.keys()].find((id) => room.players.get(id).connected) ?? [...room.players.keys()][0];
    }
    applyResult(room, res);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Devine tête — serveur sur http://localhost:${PORT}`);
});
