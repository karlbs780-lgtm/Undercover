// Logique cote joueur, pilotee par la phase envoyee par le serveur.
// Le client n'a AUCUN secret : il affiche l'etat public + sa propre carte.

const socket = io();

let myId = null;
let state = null;
let myRole = null; // { role, word } recu en prive
let myVote = null; // id vote localement (surbrillance)

const $ = (id) => document.getElementById(id);
const show = (el) => $(el).classList.remove("hidden");
const hide = (el) => $(el).classList.add("hidden");

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const ROLE_INFO = {
  civil: { name: "Civil", hint: "Trouve les imposteurs sans dévoiler ton mot." },
  imposteur: { name: "Imposteur", hint: "Fais-toi passer pour un civil." },
  mister_white: { name: "Mister White", hint: "Tu n'as pas de mot. Bluffe à partir des indices des autres !" },
};
const ROLE_LABEL = { civil: "Civil", imposteur: "Imposteur", mister_white: "Mister White" };

// --- Accueil -------------------------------------------------------------

function currentName() {
  return $("name-input").value.trim();
}

$("create-btn").addEventListener("click", () => {
  const name = currentName();
  if (!name) return ($("home-error").textContent = "Entre un pseudo d'abord.");
  socket.emit("create_room", { name }, (res) => {
    if (!res?.ok) return ($("home-error").textContent = res?.error || "Erreur.");
    myId = res.playerId;
    state = res.state;
    showScreen("screen-lobby");
    renderLobby();
  });
});

$("join-btn").addEventListener("click", () => {
  const name = currentName();
  const code = $("code-input").value.trim().toUpperCase();
  if (!name) return ($("home-error").textContent = "Entre un pseudo d'abord.");
  if (!code) return ($("home-error").textContent = "Entre un code de partie.");
  socket.emit("join_room", { code, name }, (res) => {
    if (!res?.ok) return ($("home-error").textContent = res?.error || "Erreur.");
    myId = res.playerId;
    state = res.state;
    showScreen("screen-lobby");
    renderLobby();
  });
});

function isHost() {
  return state && myId === state.hostId;
}

// --- Lobby ---------------------------------------------------------------

function renderLobby() {
  if (!state) return;
  $("room-code").textContent = state.code;
  $("player-count").textContent = state.counts.players;

  const list = $("player-list");
  list.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    const crown = p.id === state.hostId ? '<span class="host-crown">👑</span>' : "";
    const isYou = p.id === myId;
    li.innerHTML = `${crown}<span class="${isYou ? "you" : ""}">${escapeHtml(p.name)}</span>${isYou ? '<span class="tag">toi</span>' : ""}`;
    list.appendChild(li);
  }

  if (isHost()) {
    show("host-settings");
    hide("waiting-msg");
    syncSettingsInputs();
  } else {
    hide("host-settings");
    show("waiting-msg");
  }
}

function syncSettingsInputs() {
  const s = state.settings;
  $("set-imposteurs").value = s.imposteurs;
  $("set-white").value = s.misterWhite;
  if (document.activeElement !== $("set-difficulte")) $("set-difficulte").value = s.difficulte || "";

  renderThemeChips();

  const avail = state.counts.availablePairs;
  $("avail-pairs").textContent = `${avail} paire${avail > 1 ? "s" : ""}`;
  $("avail-pairs").classList.toggle("none", avail === 0);

  $("civils-count").textContent = Math.max(0, state.counts.civils);
  $("imposteurs-count").textContent = s.imposteurs;
  $("white-count").textContent = s.misterWhite;

  const v = state.validation;
  let err = "";
  if (!v.valid) err = v.errors[0];
  else if (avail === 0) err = "Aucune paire pour ces filtres — élargis les thèmes ou la difficulté.";
  $("setup-error").textContent = err;
  $("start-btn").disabled = !v.valid || avail === 0;
}

// Emet les reglages courants ; `extra` permet de forcer un champ (ex: themes).
function emitSettings(extra = {}) {
  socket.emit("update_settings", {
    imposteurs: Number($("set-imposteurs").value),
    misterWhite: Number($("set-white").value),
    difficulte: $("set-difficulte").value,
    themes: extra.themes !== undefined ? extra.themes : state.settings.themes || [],
  });
}

// Compteurs +/-
document.querySelectorAll(".step-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.target);
    const next = Math.max(0, Number(input.value) + Number(btn.dataset.delta));
    input.value = next;
    emitSettings();
  });
});
$("set-difficulte").addEventListener("change", () => emitSettings());

function renderThemeChips() {
  const wrap = $("theme-chips");
  const selected = state.settings.themes || [];
  wrap.innerHTML = "";

  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "chip" + (selected.length === 0 ? " active" : "");
  allChip.textContent = "Tous";
  allChip.addEventListener("click", () => emitSettings({ themes: [] }));
  wrap.appendChild(allChip);

  for (const t of state.allThemes || []) {
    const active = selected.includes(t);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (active ? " active" : "");
    chip.textContent = t;
    chip.addEventListener("click", () => {
      let sel = [...(state.settings.themes || [])];
      sel = sel.includes(t) ? sel.filter((x) => x !== t) : [...sel, t];
      emitSettings({ themes: sel });
    });
    wrap.appendChild(chip);
  }
}

$("start-btn").addEventListener("click", () => {
  socket.emit("start_game", {}, (res) => {
    if (!res?.ok) $("setup-error").textContent = res?.error || "Impossible de lancer.";
  });
});

// --- Révélation de la carte ---------------------------------------------

function renderRoleCard(info) {
  const meta = ROLE_INFO[info.role] || { name: info.role, hint: "" };
  const card = $("role-card");
  card.className = "flip-face flip-front role-card " + info.role; // garde la face 3D
  $("role-name").textContent = meta.name;
  $("role-word").textContent = info.word || "???";
  $("role-hint").textContent = meta.hint;

  if (isHost()) {
    show("begin-clues-btn");
    hide("reveal-wait");
  } else {
    hide("begin-clues-btn");
    show("reveal-wait");
  }
}

// Touche la carte pour la retourner (révélation 3D + confidentialité).
$("reveal-flip").addEventListener("click", () => {
  $("reveal-flip").classList.toggle("flipped");
});

$("begin-clues-btn").addEventListener("click", () => {
  socket.emit("begin_clues", {});
});

// --- Écran de jeu (indices / vote / white) ------------------------------

function renderGame() {
  showScreen("screen-game");

  // Rappel de mon role/mot
  if (myRole) {
    const chip = $("my-role-chip");
    chip.className = "role-chip " + myRole.role;
    const label = ROLE_LABEL[myRole.role] || myRole.role;
    chip.textContent = myRole.word ? `${label} · ${myRole.word}` : label;
  }
  $("round-chip").textContent = "Manche " + state.round;

  renderClueLog();

  hide("phase-indices");
  hide("phase-vote");
  hide("phase-white");

  if (state.phase === "INDICES") renderIndices();
  else if (state.phase === "VOTE") renderVote();
  else if (state.phase === "WHITE_GUESS") renderWhite();
}

function renderClueLog() {
  const log = $("clue-log");
  log.innerHTML = "";
  for (const c of state.clues) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="clue-author">${escapeHtml(c.name)}</span><span class="clue-text">${escapeHtml(c.text)}</span>`;
    log.appendChild(li);
  }
  log.scrollTop = log.scrollHeight;
}

function renderIndices() {
  show("phase-indices");
  const myTurn = state.turnId === myId;
  const meAlive = state.players.find((p) => p.id === myId)?.alive;
  if (myTurn) {
    $("turn-info").textContent = "À toi de donner un indice.";
    show("clue-input-row");
    $("clue-input").focus?.();
  } else {
    $("turn-info").textContent = meAlive
      ? `Au tour de ${state.turnName ?? "…"}…`
      : `Tu es éliminé. Au tour de ${state.turnName ?? "…"}…`;
    hide("clue-input-row");
  }
}

function sendClue() {
  const text = $("clue-input").value.trim();
  if (!text) return;
  socket.emit("submit_clue", { text }, (res) => {
    if (!res?.ok) return ($("game-error").textContent = res?.error || "Erreur.");
    $("game-error").textContent = "";
    $("clue-input").value = "";
  });
}
$("clue-send").addEventListener("click", sendClue);
$("clue-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendClue();
});

function renderVote() {
  show("phase-vote");
  const meAlive = state.players.find((p) => p.id === myId)?.alive;
  const votedCount = state.voters.length;
  $("vote-progress").textContent = `${votedCount} / ${state.aliveCount} ont voté`;

  const list = $("vote-list");
  list.innerHTML = "";
  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.id === myId) continue; // pas de vote pour soi
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "btn vote-btn" + (myVote === p.id ? " voted" : "");
    btn.textContent = p.name;
    btn.disabled = !meAlive;
    btn.addEventListener("click", () => castVote(p.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
  if (!meAlive) $("vote-progress").textContent = `Tu es éliminé. ${votedCount} / ${state.aliveCount} ont voté`;
}

function castVote(targetId) {
  myVote = targetId;
  renderVote();
  socket.emit("cast_vote", { targetId }, (res) => {
    if (!res?.ok) $("game-error").textContent = res?.error || "Erreur.";
  });
}

function renderWhite() {
  show("phase-white");
  if (state.pendingWhiteId === myId) {
    show("white-guess-me");
    hide("white-guess-wait");
    $("white-input").focus?.();
  } else {
    hide("white-guess-me");
    show("white-guess-wait");
  }
}

function sendWhiteGuess() {
  const guess = $("white-input").value.trim();
  if (!guess) return;
  socket.emit("white_guess", { guess }, (res) => {
    if (!res?.ok) $("game-error").textContent = res?.error || "Erreur.";
  });
}
$("white-send").addEventListener("click", sendWhiteGuess);
$("white-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendWhiteGuess();
});

// --- Fin de partie -------------------------------------------------------

function renderEnd(reveal) {
  showScreen("screen-end");
  const banner = $("end-banner");
  if (reveal.winner === "civils") {
    banner.textContent = "Les civils gagnent !";
    banner.className = "end-banner win-civils";
    $("end-trophy").textContent = "🏆";
  } else {
    banner.textContent = "Les imposteurs gagnent !";
    banner.className = "end-banner win-traitres";
    $("end-trophy").textContent = "🕵️";
  }
  launchConfetti(reveal.winner);
  $("end-reason").textContent = reveal.reason || "";
  $("end-word").textContent = reveal.pair ? reveal.pair.civil : "—";

  const list = $("end-roles");
  list.innerHTML = "";
  for (const r of reveal.roles) {
    const li = document.createElement("li");
    const label = ROLE_LABEL[r.role] || r.role;
    const w = r.word ? ` · ${r.word}` : "";
    li.innerHTML = `<span class="er-name">${escapeHtml(r.name)}</span><span class="er-role ${r.role}">${label}${escapeHtml(w)}</span>`;
    list.appendChild(li);
  }

  if (isHost()) {
    show("again-btn");
    hide("end-wait");
  } else {
    hide("again-btn");
    show("end-wait");
  }
}

$("again-btn").addEventListener("click", () => {
  socket.emit("play_again", {});
});

// --- Réception des messages serveur -------------------------------------

socket.on("state", (s) => {
  state = s;
  myId = myId || socket.id;

  switch (s.phase) {
    case "LOBBY":
      myRole = null;
      myVote = null;
      if (!$("screen-home").classList.contains("active")) {
        showScreen("screen-lobby");
        renderLobby();
      }
      break;
    case "REVEAL":
      // La carte est affichee via "your_role"; on gere juste le bouton hote.
      if ($("screen-reveal").classList.contains("active")) renderRoleCard(myRole || { role: "civil" });
      break;
    case "INDICES":
    case "VOTE":
    case "WHITE_GUESS":
      if (state.phase !== "VOTE") myVote = null; // reset entre les tours
      renderGame();
      break;
    case "ENDED":
      // L'ecran de fin est rendu via "game_over".
      break;
  }
});

socket.on("your_role", (info) => {
  myRole = info;
  renderRoleCard(info);
  $("reveal-flip").classList.remove("flipped"); // carte face cachée au départ
  showScreen("screen-reveal");
});

socket.on("game_started", (info) => {
  const el = $("first-speaker");
  if (info.firstSpeaker) el.innerHTML = `<strong>${escapeHtml(info.firstSpeaker)}</strong> commencera le tour d'indices.`;
});

socket.on("vote_tie", (info) => {
  showBanner(`Égalité entre ${info.tied.map(escapeHtml).join(", ")} — revotez !`, "warn");
  myVote = null;
});

socket.on("elimination", (info) => {
  showElimOverlay(info);
});

socket.on("white_result", (info) => {
  if (info.correct) showBanner(`Mister White a deviné juste (${escapeHtml(info.guess)}) !`, "mister_white");
  else showBanner(`Mister White s'est trompé (${escapeHtml(info.guess)}).`, "warn");
});

socket.on("game_over", (reveal) => {
  // Si l'overlay d'élimination est encore affiché, on attend sa fermeture.
  if (!$("elim-overlay").classList.contains("hidden")) pendingEnd = reveal;
  else renderEnd(reveal);
});

// --- Overlay d'élimination (annonce 3D du rôle) -------------------------

let pendingEnd = null;
let elimTimer = null;

const VERDICT = {
  imposteur: "était un IMPOSTEUR",
  mister_white: "était MISTER WHITE",
  civil: "était INNOCENT",
};

function showElimOverlay(info) {
  $("elim-name").textContent = info.name;
  $("elim-verdict").textContent = VERDICT[info.role] || "";
  $("elim-front").className = "flip-face flip-front elim-front " + info.role;

  $("elim-overlay").classList.remove("hidden");

  // (re)lance le tournoiement 3D
  const inner = $("elim-inner");
  inner.classList.remove("reveal");
  void inner.offsetWidth; // force un reflow pour rejouer l'animation
  inner.classList.add("reveal");

  clearTimeout(elimTimer);
  elimTimer = setTimeout(dismissElim, 4500);
}

function dismissElim() {
  clearTimeout(elimTimer);
  $("elim-overlay").classList.add("hidden");
  if (pendingEnd) {
    const r = pendingEnd;
    pendingEnd = null;
    renderEnd(r);
  }
}
$("elim-continue").addEventListener("click", dismissElim);

// Banniere transitoire dans l'ecran de jeu.
let bannerTimer = null;
function showBanner(text, kind) {
  const b = $("banner");
  b.textContent = text;
  b.className = "banner " + (kind || "");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add("hidden"), 5000);
}

// --- Confettis (canvas, sans librairie) ---------------------------------

function launchConfetti(winner) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = $("confetti");
  const ctx = canvas.getContext("2d");
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const W = (canvas.width = window.innerWidth * DPR);
  const H = (canvas.height = window.innerHeight * DPR);

  const palettes = {
    civils: ["#4cd7a0", "#6c5ce7", "#f2f2f7", "#3ec7ff"],
    traitres: ["#e06c6c", "#e6c84c", "#f2f2f7", "#ff9f6c"],
  };
  const colors = palettes[winner] || palettes.civils;

  const N = 150;
  const parts = Array.from({ length: N }, () => ({
    x: Math.random() * W,
    y: -Math.random() * H * 0.4,
    r: (6 + Math.random() * 8) * DPR,
    c: colors[(Math.random() * colors.length) | 0],
    vx: (Math.random() - 0.5) * 3 * DPR,
    vy: (2.5 + Math.random() * 4) * DPR,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.25,
    life: 1,
  }));

  const start = performance.now();
  const DURATION = 2800;

  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05 * DPR; // gravité
      p.rot += p.vr;
      if (elapsed > DURATION - 800) p.life = Math.max(0, p.life - 0.02);

      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx.restore();
    }
    if (elapsed < DURATION) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, W, H);
    }
  }
  requestAnimationFrame(frame);
}
