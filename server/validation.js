// Les 4 garde-fous d'equilibrage. Le serveur REFUSE de lancer une partie
// si l'un d'eux est viole, quels que soient les reglages de l'hote.
//
// Regles :
//   1. Minimum 3 joueurs.
//   2. Au moins 2 civils (sinon plus personne pour enqueter).
//   3. Les civils restent strictement majoritaires : traitres < civils.
//   4. Au moins 1 role "traitre" (imposteur OU Mister White).

export function computeCivils(players, imposteurs, misterWhite) {
  return players - imposteurs - misterWhite;
}

export function validateSetup({ players, imposteurs, misterWhite }) {
  const civils = computeCivils(players, imposteurs, misterWhite);
  const traitres = imposteurs + misterWhite;
  const errors = [];

  if (players < 3) {
    errors.push("Il faut au moins 3 joueurs pour lancer une partie.");
  }
  if (imposteurs < 0 || misterWhite < 0) {
    errors.push("Les nombres d'imposteurs et de Mister White doivent être positifs.");
  }
  if (traitres < 1) {
    errors.push("Il faut au moins 1 imposteur ou 1 Mister White.");
  }
  if (civils < 2) {
    errors.push("Il faut au moins 2 civils.");
  }
  if (traitres >= civils && players >= 3) {
    errors.push("Les civils doivent rester majoritaires : trop d'imposteurs / Mister White.");
  }

  return { valid: errors.length === 0, errors, civils, traitres };
}
