// Logique de jeu pure (sans reseau) : reglages par defaut, tirage des paires
// et distribution des roles. Testable isolement.

import { WORD_PAIRS, pairKey } from "./words.js";

// Barème automatique propose a l'hote (qu'il peut ensuite ajuster).
//   imposteurs   = max(1, floor((joueurs - 2) / 3))  -> reproduit le tableau
//                  de reference (1 jusqu'a 7 joueurs, 2 des 8, 3 des 11...)
//   mister white = 1 des 5 joueurs, sinon 0
// Filet de securite : on reduit les imposteurs si besoin pour que le defaut
// respecte TOUJOURS les garde-fous (civils strictement majoritaires + >= 2 civils).
export function defaultSetup(players) {
  const misterWhite = players >= 5 ? 1 : 0;
  let imposteurs = Math.max(1, Math.floor((players - 2) / 3));

  const maxTraitres = Math.min(
    Math.floor((players - 1) / 2), // traitres < civils
    players - 2 // au moins 2 civils
  );
  while (imposteurs > 1 && imposteurs + misterWhite > maxTraitres) {
    imposteurs--;
  }
  return { imposteurs, misterWhite };
}

// Melange de Fisher-Yates (retourne un nouveau tableau).
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Filtre le dictionnaire selon les criteres de l'hote.
//   difficulte : "facile" | "moyen" | "difficile" | null (tous)
//   themes     : tableau de themes autorises, ou vide/null (tous)
//   exclude    : Set de cles de paires deja jouees (anti-repetition)
export function filterPairs({ difficulte = null, themes = null, exclude = null } = {}) {
  let pool = WORD_PAIRS;
  if (themes && themes.length) pool = pool.filter((p) => themes.includes(p.theme));
  if (difficulte) pool = pool.filter((p) => p.difficulte === difficulte);
  if (exclude && exclude.size) pool = pool.filter((p) => !exclude.has(pairKey(p)));
  return pool;
}

// Tire une paire au hasard selon les filtres (ou null si aucune dispo).
export function drawPair(filters = {}) {
  const pool = filterPairs(filters);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Nombre de paires disponibles pour des filtres donnes (pour l'UI de l'hote).
export function countAvailablePairs(filters = {}) {
  return filterPairs(filters).length;
}

// Distribue les roles a partir d'une liste d'identifiants de joueurs et d'une
// paire de mots. Retourne :
//   roles        : { [playerId]: { role, word } }
//   firstSpeaker : id du joueur qui commence (toujours un CIVIL, pour ne pas
//                  desavantager le Mister White ni exposer un imposteur d'entree)
export function assignRoles(playerIds, setup, pair) {
  const ids = shuffle(playerIds);
  const roles = {};
  let i = 0;

  for (let k = 0; k < setup.imposteurs; k++) {
    roles[ids[i++]] = { role: "imposteur", word: pair.imposteur };
  }
  for (let k = 0; k < setup.misterWhite; k++) {
    roles[ids[i++]] = { role: "mister_white", word: null };
  }
  for (; i < ids.length; i++) {
    roles[ids[i]] = { role: "civil", word: pair.civil };
  }

  const civilIds = ids.filter((id) => roles[id].role === "civil");
  const firstSpeaker = civilIds[Math.floor(Math.random() * civilIds.length)];

  return { roles, firstSpeaker };
}
