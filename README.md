# YouFind

**Découvre et organise des chaînes YouTube sans algorithme, sans pub, sans tracker.**

YouFind est un outil de curation vidéo qui tourne en local. Au lieu de subir l'algorithme de YouTube, tu ajoutes toi-même des chaînes, les organises par thèmes, découvres des chaînes similaires, et laisses un LLM local t'aider à prioriser ce qui mérite ton temps.

---

## Concept

YouTube veut te garder le plus longtemps possible. YouFind fait l'inverse : il t'aide à trouver **les bonnes chaînes** et à ne regarder que ce qui t'intéresse vraiment.

- **Scraping HTML** (gratuit, pas de clé API) pour la découverte, les infos chaîne et les vidéos
- **API YouTube Data v3** en fallback seulement (quotidien de 10 000 unités)
- **LLM local** (Ollama, LM Studio) pour scorer la pertinence des chaînes
- **Feed RSS** de YouTube pour récupérer les vidéos (gratuit, pas de quota)
- **Tout tourne chez toi** — zéro dépendance externe

---

## Fonctionnalités

### Gestion des chaînes
- Ajout par **URL**, **handle** (`@chaine`), **ID YouTube**, **recherche** ou **URL de vidéo**
- Import en **batch** : copie du texte avec des liens YouTube, tout est extrait automatiquement
- Statuts : **en attente**, **validée**, **rejetée**
- Rafraîchissement automatique des stats (abonnés, miniature, nom)

### Feed vidéo
- Grille infinie avec les vidéos des chaînes validées
- Tri par **date**, **vues**, **engagement** (vues/abonnés) ou **score LLM**
- Filtrage par **thème**
- Filtrage automatique des **Shorts** (vidéos < 60s)
- Marquage des vidéos déjà vues (localStorage)
- Lecteur YouTube intégré dans une modale

### Découverte de chaînes
- **Par thème** : entre un mot-clé, YouFind scrape les résultats YouTube et les importe automatiquement
- **Chaînes similaires** : depuis toutes tes chaînes validées, explore les recommandations YouTube et ne garde que les **chaînes françaises** (filtre automatique)

### Scoring LLM
- Un LLM local note chaque chaîne de 0 à 100 sur sa pertinence
- Le prompt inclut les vidéos récentes et l'historique des rejets
- Les scores sont colorés dans l'UI (vert > 6, jaune 3-6, rouge < 3)

### Organisation par thèmes
- Crée des thèmes (ex: "histoire", "programmation", "true crime")
- Assigné des chaînes aux thèmes
- Filtre le feed par thème

### Automatisation
- **RSS** : les vidéos des chaînes validées sont récupérées toutes les 24h
- **Découverte** : une exploration thématique est lancée tous les 3 jours
- Rafraîchissement des stats et scoring LLM en arrière-plan

### Dashboard
- Vidéos récentes des meilleures chaînes
- Chaînes en attente avec validation rapide
- Top chaînes par score LLM
- Statistiques globales

---

## Prérequis

- [Bun](https://bun.sh) (v1.0+)
- Optionnel : [Ollama](https://ollama.ai) ou [LM Studio](https://lmstudio.ai) pour le scoring LLM

## Installation

```bash
git clone <url-du-repo>
cd youfind
bun install
```

## Configuration

Crée un fichier `.env` à la racine (ou modifie celui existant) :

```env
PORT=3001
YOUTUBE_API_KEY=           # Optionnel, pour le fallback API
LLM_PROVIDER=ollama        # ollama | lmstudio | openrouter
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
LMSTUDIO_URL=http://localhost:1234
LMSTUDIO_MODEL=default
OPENROUTER_KEY=            # Si tu utilises OpenRouter
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
```

Toutes les options sont configurables depuis l'interface web (onglet **Réglages**).

## Lancement

```bash
bun run dev      # Avec hot-reload
# ou
bun run start    # Sans hot-reload
```

Ouvre **http://localhost:3001** (ou le port configuré).

## Commandes utiles

```bash
bun run cron     # Exécute RSS + découverte immédiatement
bun run refresh  # Rafraîchit les vidéos RSS (sortie JSON)
```

---

## Architecture

```
youfind/
├── src/
│   ├── server.js        # Serveur HTTP (Bun), routes API, fichiers statiques
│   ├── db.js            # Base SQLite, tables, index, prepared statements
│   ├── youtube-api.js   # Scraping YouTube, résolution, découverte, détection français
│   ├── rss.js           # Récupération des vidéos via RSS YouTube
│   ├── llm.js           # Scoring LLM (Ollama, LM Studio, OpenRouter)
│   └── cron.js          # Tâches planifiées (RSS 24h, découverte 3j)
├── public/
│   ├── index.html       # Interface utilisateur (SPA, Bootstrap 5)
│   ├── js/app.js        # Logique frontend (navigation, API, UI)
│   └── css/style.css    # Thème dark purple glassmorphism
├── package.json
├── tsconfig.json
└── .env
```

### Base de données

`youfind.db` (SQLite) est créée automatiquement au premier lancement.

- **channels** : chaînes YouTube (nom, ID, statut, abonnés, score LLM, miniature)
- **videos** : vidéos importées (titre, description, URL, durée, vues)
- **topics** : thèmes (nom, description)
- **channel_topics** : association chaîne ↔ thème
- **feedback_log** : historique des validations/rejets (pour le prompt LLM)

---

## API

Toutes les routes sont préfixées par `/api/`.

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/stats` | Statistiques globales |
| GET | `/api/videos` | Feed vidéo (paginé, tri, filtre) |
| GET | `/api/channels` | Liste des chaînes (filtre par statut) |
| POST | `/api/channels` | Ajouter une chaîne |
| POST | `/api/channels/resolve` | Résoudre une URL/handle/recherche |
| POST | `/api/channels/import` | Import batch depuis du texte |
| POST | `/api/channels/:id/validate` | Valider une chaîne |
| POST | `/api/channels/:id/reject` | Rejeter une chaîne |
| POST | `/api/channels/:id/score` | Scorer une chaîne (LLM) |
| GET | `/api/channels/:id/detail` | Détail complet d'une chaîne |
| GET | `/api/channels/:id/related` | Chaînes similaires |
| GET | `/api/channels/:id/preview` | 3 dernières vidéos (miniature) |
| GET | `/api/dashboard` | Données pour l'accueil |
| POST | `/api/discover` | Découverte par thème |
| POST | `/api/discover/related` | Découverte des similaires français |
| POST | `/api/score-all` | Scorer toutes les chaînes en attente |
| POST | `/api/refresh` | Rafraîchir les vidéos RSS |
| POST | `/api/ingest/:channelId` | Ingérer manuellement les vidéos |
| GET | `/api/topics` | Liste des thèmes |
| POST | `/api/topics` | Créer un thème |
| GET | `/api/llm-status` | Statut du LLM |
| GET | `/api/settings` | Configuration |
| POST | `/api/settings` | Mettre à jour la configuration |

---

## Utilisation rapide

1. **Ajoute des chaînes** → onglet **Chaînes** → bouton **+**
   - Colle une URL YouTube, un handle, ou une URL de vidéo
   - Ou utilise **Import batch** pour en ajouter plusieurs d'un coup

2. **Valide les chaînes pertinentes** → onglet **Chaînes** → filtre "En attente"
   - Vert = valide, Rouge = rejette (avec raison)

3. **Scorer avec le LLM** → onglet **Chaînes** → bouton **Scorer tout**
   - Les notes t'aident à prioriser les meilleures chaînes

4. **Découvre des chaînes similaires** → onglet **Similaires**
   - YouFind analyse tes chaînes validées et trouve automatiquement des chaînes françaises connexes

5. **Organise par thèmes** → onglet **Thèmes**
   - Crée des thèmes et assigne-leur des chaînes

6. **Regarde le feed** → onglet **Vidéos**
   - Trie, filtre, et mate les dernières vidéos de tes chaînes

---

## Licence

MIT
