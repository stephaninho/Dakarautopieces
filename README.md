# CANASEN Backend API

Backend Node.js/Express pour l'application CANASEN — Pièces Auto Canada → Sénégal.

## 🚀 Installation

```bash
npm install
cp .env.example .env
# Remplis les valeurs dans .env
npm run dev
```

## 📡 Endpoints

| Méthode | Route | Description |
|---|---|---|
| GET | `/` | Health check |
| GET | `/api/orders` | Récupérer toutes les commandes |
| POST | `/api/orders` | Créer une commande |
| PATCH | `/api/orders/:id/status` | Changer le statut |
| PATCH | `/api/orders/:id/note` | Ajouter une note |
| POST | `/api/orders/:id/notify-arrival` | Notifier le client à Dakar |

## 🌍 Déploiement sur Render (gratuit)

1. Va sur [render.com](https://render.com)
2. New → Web Service → Connect GitHub repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Ajoute les variables d'environnement depuis `.env.example`
