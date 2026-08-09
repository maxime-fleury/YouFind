# YouFind

**Découvre et organise des chaînes YouTube sans algorithme, sans pub, sans tracker.**

YouFind est un outil de curation vidéo qui tourne en local. Au lieu de subir l'algorithme de YouTube, tu ajoutes toi-même des chaînes, les organises par thèmes, découvres des chaînes similaires, et laisses un LLM local t'aider à prioriser ce qui mérite ton temps.

---

## Concept

YouTube veut te garder le plus longtemps possible. YouFind fait l'inverse : il t'aide à trouver **les bonnes chaînes** et à ne regarder que ce qui t'intéresse vraiment.

- **Scraping HTML uniquement** — gratuit, zéro clé API, zéro quota
- **LLM local** (Ollama, LM Studio, OpenRouter) pour scorer la pertinence des chaînes
- **Feed RSS** de YouTube pour récupérer les vidéos (gratuit)
- **Tout tourne chez toi** — aucune dépendance externe payante

---

## Fonctionnalités

### Gestion des chaînes
- Ajout par **URL**, **handle** (`@chaine`), **ID YouTube**, **recherche** ou **URL de vidéo**
- Import en **batch** : colle du texte avec des liens YouTube, tout est extrait automatiquement
- Statuts : **en attente**, **validée**, **rejetée**
- **Tri** par date d'ajout, nom, score LLM, abonnés
- **Filtres** : statut, scorées / non scorées, recherche full-text
- **Vue compacte** en tableau avec toggle liste/grille
- **Badge "New"** sur les chaînes ajoutées il y a moins de 24h
- **Compteur de vidéos** par chaîne
- Badge **"RSS il y a Xh"** indiquant le dernier rafraîchissement
- Rafraîchissement des stats (abonnés, miniature, nom) — **parallèle (3 workers)**

### Feed vidéo
- Grille infinie avec les vidéos des chaînes validées
- Tri par **date**, **vues**, **engagement** (vues/abonnés), **score LLM** ou **pertinence** (recherche)
- Filtrage par **thème**
- Filtrage automatique des **Shorts** (vidéos < 60s)
- Marquage des vidéos déjà vues (localStorage)
- Lecteur YouTube intégré dans une modale
- Prefetch de la page suivante en arrière-plan

### Découverte de chaînes
- **Par thème** : entre un mot-clé, YouFind scrape les résultats YouTube et les importe automatiquement
- **Chaînes similaires** : explore les recommandations YouTube depuis les chaînes de ton choix
  - **Multi-statuts** : choisis parmi validées, en attente, rejetées (sélection multiple)
  - **Passages multiples** : scrape chaque chaîne N fois pour varier les suggestions
  - **Annuler / Pause** : contrôle total pendant l'exploration (5 workers parallèles)
  - **Ordre aléatoire** : les seeds sont mélangées à chaque run
  - Filtre automatique des **chaînes françaises**

### Scoring LLM
- Un LLM local note chaque chaîne de 0 à 100 sur sa pertinence
- Le prompt inclut les vidéos récentes et l'historique des rejets
- **Concurrence configurable** (1-10 workers) dans les Réglages
- **Diagnostic des échecs** : la console navigateur affiche un groupe dépliable avec la raison de chaque échec (chaîne supprimée, pas de vidéos, erreur LLM…)
- Les scores sont colorés dans l'UI (vert ≥ 70, jaune ≥ 40, rouge < 40)

### Organisation par thèmes
- Crée des thèmes (ex : "histoire", "programmation", "true crime")
- **Drag & drop** pour réordonner les thèmes
- Assigné des chaînes aux thèmes
- Filtre le feed par thème

### Automatisation (cron)
- **RSS** : les vidéos des chaînes validées sont récupérées toutes les 24h
- **Découverte** : une exploration thématique est lancée tous les 3 jours
- **Backup** : sauvegarde quotidienne de la base SQLite (14 jours conservés)
- Rafraîchissement des stats et scoring LLM en arrière-plan

### Dashboard
- Vidéos récentes des meilleures chaînes
- Chaînes en attente avec validation rapide
- Top chaînes par score LLM
- Statistiques globales
- Compte à rebours jusqu'au prochain refresh RSS

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
LLM_PROVIDER=ollama        # ollama | lmstudio | openrouter
LLM_CONCURRENCY=3          # Nombre de chaînes scorées en parallèle (1-10)
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
bun run backup   # Sauvegarde manuelle de la base
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
│   ├── cron.js          # Tâches planifiées (RSS 24h, découverte 3j, backup quotidien)
│   ├── backup.js        # Sauvegarde SQLite (VACUUM INTO)
│   └── utils.js         # runWithLimit (concurrence contrôlée)
├── public/
│   ├── index.html       # Interface utilisateur (SPA, Bootstrap 5)
│   ├── js/app.js        # Logique frontend (navigation, API, UI)
│   └── css/style.css    # Thème dark purple glassmorphism
├── package.json
└── .env
```

### Base de données

`youfind.db` (SQLite) est créée automatiquement au premier lancement.

- **channels** : chaînes YouTube (nom, ID, statut, abonnés, score LLM, miniature, description, date dernier refresh)
- **videos** : vidéos importées (titre, description, URL, durée, vues)
- **topics** : thèmes (nom, description, ordre d'affichage)
- **channel_topics** : association chaîne ↔ thème
- **feedback_log** : historique des validations/rejets (pour le prompt LLM)
- **settings** : configuration (clés/valeurs)
- **channels_fts** : index full-text (FTS5 trigram) pour la recherche de chaînes

---

## API

Toutes les routes sont préfixées par `/api/`.

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/stats` | Statistiques globales + infos RSS |
| GET | `/api/videos` | Feed vidéo (paginé, tri, filtre, recherche FTS) |
| GET | `/api/channels` | Liste des chaînes (filtre statut/scored, tri, recherche) |
| POST | `/api/channels` | Ajouter une chaîne |
| POST | `/api/channels/resolve` | Résoudre une URL/handle/recherche |
| POST | `/api/channels/import` | Import batch depuis du texte |
| POST | `/api/channels/:id/validate` | Valider une chaîne |
| POST | `/api/channels/:id/reject` | Rejeter une chaîne |
| POST | `/api/channels/:id/score` | Scorer une chaîne (LLM) |
| GET | `/api/channels/:id/detail` | Détail complet d'une chaîne (vidéos, similaires) |
| GET | `/api/channels/:id/related` | Chaînes similaires |
| GET | `/api/channels/:id/preview` | 3 dernières vidéos (miniature) |
| POST | `/api/channels/refresh-stats` | Rafraîchir stats de toutes les chaînes |
| GET | `/api/refresh-stats/status` | Progression du refresh stats |
| POST | `/api/discover` | Découverte par thème |
| POST | `/api/discover/related` | Démarrer l'exploration des similaires |
| GET | `/api/discover/related/status` | Progression + résultats en streaming |
| POST | `/api/discover/related/cancel` | Annuler l'exploration en cours |
| POST | `/api/discover/related/pause` | Pause / Reprendre l'exploration |
| POST | `/api/score-all` | Scorer toutes les chaînes en attente |
| POST | `/api/score-unscored` | Scorer toutes les chaînes sans score |
| POST | `/api/rescore-all` | Re-scorer toutes les chaînes |
| GET | `/api/score-status` | Progression du scoring |
| POST | `/api/refresh` | Rafraîchir les vidéos RSS des chaînes validées |
| GET | `/api/refresh/status` | Progression du refresh RSS |
| POST | `/api/refresh-videos` | Deep crawl vidéos de toutes les chaînes validées |
| POST | `/api/refresh-pending-videos` | Deep crawl vidéos des chaînes en attente |
| POST | `/api/ingest/:channelId` | Ingérer les vidéos d'une chaîne |
| POST | `/api/ingest/:channelId/deep` | Deep crawl complet d'une chaîne |
| GET | `/api/topics` | Liste des thèmes (triés par ordre) |
| POST | `/api/topics` | Créer un thème |
| PATCH | `/api/topics` | Réordonner les thèmes (drag & drop) |
| DELETE | `/api/topics` | Supprimer un thème |
| GET | `/api/llm-status` | Statut du LLM |
| GET | `/api/rss-info` | Dernier refresh RSS (timestamp) |
| GET | `/api/settings` | Configuration publique |
| POST | `/api/settings` | Mettre à jour la configuration |
| GET | `/api/feedback` | Historique des validations/rejets |

---

## Utilisation rapide

1. **Ajoute des chaînes** → onglet **Chaînes** → bouton **+**
   - Colle une URL YouTube, un handle, ou une URL de vidéo
   - Ou utilise **Import batch** pour en ajouter plusieurs d'un coup

2. **Valide les chaînes pertinentes** → onglet **Chaînes** → filtre "En attente"
   - Vert = valide, Rouge = rejette (avec raison)
   - Utilise la **vue compacte** pour trier et filtrer rapidement

3. **Score avec le LLM** → onglet **Découvrir** → bouton **Score all unscored**
   - Les notes t'aident à prioriser les meilleures chaînes
   - Consulte la console (F12) pour le détail des échecs de scoring

4. **Découvre des chaînes similaires** → onglet **Similaires**
   - Sélectionne les statuts sources (validées par défaut)
   - Lance l'exploration, mets en pause ou annule à tout moment
   - Les résultats arrivent en direct, filtrés français uniquement

5. **Organise par thèmes** → onglet **Découvrir**
   - Crée des thèmes, glisse-dépose pour les réordonner
   - Les chaînes scorées sont automatiquement assignées aux thèmes

6. **Regarde le feed** → onglet **Vidéos**
   - Trie, filtre par thème, et mate les dernières vidéos

---

## Licence

MIT
