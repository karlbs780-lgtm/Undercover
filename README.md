# Devine tête — le jeu de l'imposteur

Jeu de l'imposteur multijoueur (web) : chacun joue sur son téléphone, l'hôte crée
une partie et partage un code. Un joueur reçoit un mot légèrement différent
(l'imposteur), un autre n'a aucun mot (Mister White). Indices à tour de rôle,
votes, éliminations et bluff.

## Lancer en local

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000 (les autres joueurs du même réseau Wi-Fi
utilisent l'adresse IP locale de la machine, ex. `http://192.168.1.20:3000`).

## Stack

- **Serveur** : Node.js + Express + Socket.IO (serveur autoritaire, les mots
  secrets ne transitent qu'en messages privés).
- **Client** : HTML/CSS/JS vanilla, mobile-first, animations 3D en CSS pur.
- Un seul service Node sert le front **et** les WebSockets. Écoute `process.env.PORT`.

## Déployer en ligne (Render, gratuit)

1. Pousser ce dossier sur un dépôt GitHub.
2. Sur https://render.com : **New > Web Service**, connecter le dépôt.
3. Réglages : Build `npm install`, Start `npm start` (ou laisser Render lire
   `render.yaml`).
4. Déployer. Render fournit une URL publique en HTTPS à partager.

> Note : l'offre gratuite met le service en veille après inactivité ; le premier
> chargement après une pause peut prendre ~30–50 s, puis c'est instantané.

## Structure

```
server/    index.js · Room.js · gameLogic.js · validation.js · words.js
public/    index.html · style.css · client.js
```
