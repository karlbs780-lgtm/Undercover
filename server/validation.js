// Les garde-fous d'equilibrage. Le serveur REFUSE de lancer une partie si l'un
// d'eux est viole, quels que soient les reglages de l'hote.
//
// Camps :
//   - Bad (ennemis)      : imposteur + mister_white  -> gagnent par parite
//   - Good (enqueteurs)  : civil + gardien + devin    -> gagnent en eliminant les bad
//   - Neutre             : fou                         -> gagne s'il est elimine au vote
//
// Regles :
//   1. Minimum 3 joueurs.
//   2. Un seul Fou / Gardien / Devin au maximum.
//   3. Les compteurs tiennent dans le nombre de joueurs (civils simples >= 0).
//   4. Au moins 1 ennemi (imposteur ou Mister White).
//   5. Au moins 2 enqueteurs (civils + Gardien + Devin).
//   6. Les enqueteurs restent strictement majoritaires face aux ennemis
//      (le Fou, neutre, n'est pas compte).

export function computeCivils({ players, imposteurs, misterWhite, fou = 0, gardien = 0, devin = 0 }) {
  return players - imposteurs - misterWhite - fou - gardien - devin;
}

export function validateSetup({ players, imposteurs, misterWhite, fou = 0, gardien = 0, devin = 0 }) {
  const civils = computeCivils({ players, imposteurs, misterWhite, fou, gardien, devin });
  const bad = imposteurs + misterWhite;
  const good = civils + gardien + devin;
  const errors = [];

  if (players < 3) {
    errors.push("Il faut au moins 3 joueurs pour lancer une partie.");
  }
  if (imposteurs < 0 || misterWhite < 0 || fou < 0 || gardien < 0 || devin < 0) {
    errors.push("Les nombres de rôles doivent être positifs.");
  }
  if (fou > 1) errors.push("Un seul Fou maximum.");
  if (gardien > 1) errors.push("Un seul Gardien maximum.");
  if (devin > 1) errors.push("Un seul Devin maximum.");
  if (civils < 0) {
    errors.push("Trop de rôles spéciaux pour le nombre de joueurs.");
  }
  if (bad < 1) {
    errors.push("Il faut au moins 1 imposteur ou 1 Mister White.");
  }
  if (good < 2) {
    errors.push("Il faut au moins 2 civils (Gardien et Devin compris).");
  }
  if (bad >= good && players >= 3 && civils >= 0) {
    errors.push("Les civils doivent rester majoritaires : trop d'imposteurs / Mister White.");
  }

  return { valid: errors.length === 0, errors, civils, bad, good };
}
