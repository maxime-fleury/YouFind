# YouFind

**Découvre et organise des chaînes YouTube sans algorithme, sans pub, sans tracker.**

> Pour les agents IA et contributeurs techniques, lire [`AGENTS.md`](AGENTS.md), puis consulter [`agents/FILES.md`](agents/FILES.md) pour le rôle de chaque fichier. L'architecture détaillée est dans [`agents/ARCHITECTURE.md`](agents/ARCHITECTURE.md), les décisions dans [`agents/DECISIONS.md`](agents/DECISIONS.md) et la stratégie de tests dans [`agents/TESTING.md`](agents/TESTING.md). [`STRUCTURE.md`](STRUCTURE.md) reste l'index rapide.

YouFind est un outil de curation vidéo qui tourne en local. Au lieu de subir l'algorithme de YouTube, tu ajoutes toi-même des chaînes, les organises par thèmes, découvres des chaînes similaires, et laisses un LLM local t'aider à prioriser ce qui mérite ton temps.

---

## Concept

YouTube veut te garder le plus longtemps possible. YouFind fait l'inverse : il t'aide à trouver **les bonnes chaînes** et à ne regarder que ce qui t'intéresse vraiment.

- **Scraping HTML uniquement** — gratuit, zéro clé API, zéro quota. Aucune dépendance à l'API YouTube Data v3
- **LLM local** (Ollama, LM Studio, OpenRouter) pour scorer la pertinence des chaînes
- **Feed RSS** de YouTube pour récupérer les vidéos (gratuit)
- **Base SQLite** en local ; seuls les prompts passent par OpenRouter si tu choisis ce fournisseur cloud
- **Tout tourne chez toi** — aucune dépendance externe payante, zéro télémétrie

---

## Fonctionnalités

### 📺 Feed vidéo
- **Grille infinie** avec les vidéos des chaînes validées
- **Tri** par date, vues, engagement (vues/abonnés), score LLM, pertinence (recherche)
- **Filtrage** par thème et par texte (recherche full-text avec FTS5)
- **Exclusion automatique des Shorts** (vidéos < 60s)
- **Marquage vu/non vu** : bouton œil sur chaque miniature, persistant en base SQLite
- **Lecteur YouTube intégré** dans une modale avec overlay élégant
- **Prefetch** de la page suivante en arrière-plan
- **Position de scroll préservée** lors des changements de filtre

### 📋 Gestion des chaînes
- **Ajout** par URL, handle (`@chaine`), ID YouTube, recherche ou URL de vidéo
- **Import batch** : colle un bloc de texte contenant des liens YouTube, tout est extrait automatiquement
- **Statuts** : en attente, validée, rejetée
- **Tri** par date d'ajout, nom, score LLM, abonnés
- **Filtres avancés** : statut, scorées / non scorées, recherche full-text
- **Vue compacte** en tableau avec toggle grille/liste et colonnes triables au clic
- **Badge « New » animé** sur les chaînes ajoutées il y a moins de 24h
- **Compteur de vidéos** par chaîne dans la liste
- **Badge RSS** (« RSS il y a 3h ») indiquant le dernier rafraîchissement
- **Refresh stats parallèle** (3 workers) avec barre de progression en direct
- **Triage rapide** : ouvre une chaîne, valide/refuse, la suivante est préchargée en arrière-plan. Enchaîne des dizaines de chaînes sans latence

### 🔍 Découverte
- **Par thème** : entre un mot-clé, YouFind scrape les résultats YouTube et importe automatiquement
- **Chaînes similaires** : explore les recommandations YouTube depuis les chaînes de ton choix
  - **Multi-statuts** : choisis parmi validées, en attente, rejetées (sélection multiple)
  - **Passages multiples** (1-10) : scrape chaque chaîne N fois (les suggestions Google varient entre les visites)
  - **Annuler / Pause / Reprendre** : contrôle total pendant l'exploration
  - **5 workers parallèles** pour une exploration rapide
  - **Ordre aléatoire** (Fisher-Yates shuffle) à chaque run
  - **Filtre automatique des chaînes françaises** (détection par accents, mots-clés et métadonnées)
  - **Validation/rejet rapide** depuis les résultats, bloqués pendant l'exploration active

### 🤖 Scoring LLM
- Un LLM local (Ollama, LM Studio) ou cloud (OpenRouter) note chaque chaîne de 0 à 100
- Le prompt inclut les **vidéos récentes**, la **description** de la chaîne et l'**historique des rejets**
- **Concurrence configurable** (1-10 workers) depuis les Réglages
- **Diagnostic des échecs** : quand une chaîne ne peut pas être scorée, la console navigateur affiche un groupe dépliable avec la raison exacte :
  - `channel no longer exists on YouTube (404)` — chaîne supprimée
  - `channel exists but has no public videos` — chaîne vide
  - `failed to parse LLM response` — le LLM a mal formaté sa réponse
  - `LLM error: ...` — erreur réseau ou timeout
- Les scores sont **colorés** : vert ≥ 70, jaune ≥ 40, rouge < 40
- **Re-scoring** possible à tout moment (reset + rescore)

### 🏷️ Organisation par thèmes
- Crée des thèmes (ex : « histoire », « programmation », « true crime »)
- **Drag & drop** pour réordonner les thèmes (ordre sauvegardé en base)
- **Assignation automatique** des thèmes par le LLM pendant le scoring
- Filtre le feed vidéo par thème
- **Thèmes sauvegardés** comme favoris pour relancer une découverte en un clic

### 💾 Sauvegarde
- **Export/Import complet** en un fichier JSON : settings, topics (ordre), chaînes, vidéos, feedback et vidéos vues
- Boutons dans l'onglet **Réglages**
- Pratique pour migrer ou partager sa configuration

### ⏱️ Automatisation (cron)
- **RSS** : les vidéos des chaînes validées sont récupérées toutes les 24h (avec skip intelligent des chaînes rafraîchies récemment)
- **Découverte** : une exploration thématique est lancée tous les 3 jours pour chaque topic sauvegardé
- **Backup quotidien** de la base SQLite (14 backups conservés, rotation automatique)
- Rafraîchissement des stats et scoring LLM en arrière-plan
- Auto-ingest des vidéos au moment de la validation d'une chaîne

### 📊 Dashboard
- Vidéos récentes des meilleures chaînes
- Compteurs en direct : chaînes validées, en attente, rejetées
- Compte à rebours jusqu'au prochain refresh RSS
- Pourcentage de validation et ratio global

---

## Prérequis

- [Bun](https://bun.sh) v1.0+
- (Optionnel) [Ollama](https://ollama.ai) ou [LM Studio](https://lmstudio.ai) pour le scoring LLM
- (Optionnel) Une clé [OpenRouter](https://openrouter.ai) si tu préfères un LLM cloud

## Installation

```bash
git clone https://github.com/maxime-fleury/YouFind.git
cd youfind
bun install
```

## Configuration

Tout est configurable depuis l'interface web (onglet **Réglages**). Tu peux aussi utiliser un fichier `.env` :

```env
PORT=3000                          # Port du serveur
HOST=127.0.0.1                     # Hôte (défaut : 127.0.0.1)

# LLM
LLM_PROVIDER=ollama                # ollama | lmstudio | openrouter
LLM_CONCURRENCY=3                  # Scoring parallèle (1-10, défaut : 3)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
LMSTUDIO_URL=http://localhost:1234
LMSTUDIO_MODEL=default
OPENROUTER_KEY=                    # Clé API OpenRouter
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
```

Les clés secrètes (OpenRouter) ne sont jamais renvoyées au navigateur.

## Lancement

```bash
bun run dev      # Avec hot-reload
bun run start    # Sans hot-reload
```

Ouvre **http://localhost:3000** (ou le port configuré).

## Commandes utiles

```bash
bun run cron     # Exécute RSS + découverte immédiatement
bun run refresh  # Rafraîchit les vidéos RSS (sortie JSON)
bun run backup   # Sauvegarde manuelle de la base
bun test         # Tests unitaires et SQLite isolés
bun run check    # Vérification syntaxique des modules
```

---

## Architecture

```
youfind/
├── src/
│   ├── server.js        # Serveur HTTP (Bun), ~70 routes API, fichiers statiques
│   ├── db.js            # Base SQLite, migrations, tables, index, prepared statements
│   ├── youtube-api.js   # Scraping YouTube (réseau et orchestration)
│   ├── youtube-parsers.js # Parseurs YouTube purs et testables sans réseau
│   ├── rss.js           # Récupération des vidéos via RSS YouTube + scraping fallback
│   ├── rss-parser.js    # Parseur RSS pur et testable sur fixtures
│   ├── llm.js           # Scoring LLM (Ollama, LM Studio, OpenRouter)
│   ├── cron.js          # Tâches planifiées (RSS 24h, découverte 3j, backup quotidien)
│   ├── backup.js        # Sauvegarde SQLite (VACUUM INTO + rotation)
│   ├── utils.js         # runWithLimit (concurrence contrôlée avec délai)
│   ├── job-utils.js     # IDs et trackers de progression
│   ├── job-repository.js # Persistance et récupération des jobs SQLite
│   └── migrations.js    # Migrations versionnées de l'infrastructure
├── AGENTS.md               # Point d'entrée court pour les agents IA
├── agents/                 # Documentation technique spécialisée (< 500 lignes/fichier)
│   ├── README.md
│   ├── FILES.md
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── CONTRACTS.md
│   ├── TESTING.md
│   └── DECISIONS.md
├── TESTING.md             # Index de compatibilité vers agents/TESTING.md
├── tests/                  # Tests unitaires et fixtures locales
│   ├── http-helpers.test.js
│   ├── jobs.test.js
│   ├── parsers.test.js
│   └── utils.test.js
├── public/
│   ├── index.html       # SPA (Bootstrap 5, Bootstrap Icons)
│   ├── js/glob.constants.js # Constantes frontend partagées
│   ├── js/api.js        # Client API partagé (timeout et annulation)
│   ├── js/poller.js     # Polling générique des jobs asynchrones
│   ├── js/glob.utils.js # Utilitaires frontend globaux (formatage, sécurité, export)
│   ├── js/core.js       # État, navigation et initialisation des pages
│   ├── js/stats.js      # Dashboard et compte à rebours RSS
│   ├── js/videos.js     # Feed vidéo, pagination et prefetch
│   ├── js/settings.js   # Réglages LLM et gestion des secrets
│   ├── js/app.js        # Fonctionnalités restantes et façade historique
│   ├── css/style.css    # Manifeste CSS et ordre des imports
│   ├── css/base.css     # Fondations, composants partagés et styles legacy
│   ├── css/glob.utils.css # Classes utilitaires et animations globales
│   ├── css/videos.css   # Feed vidéo et états de chargement
│   ├── css/channels.css # Recherche et contrôles des chaînes
│   ├── css/topics.css   # Badges et sélecteur de topics
│   └── css/responsive.css # Responsive et règles transversales
├── backups/             # Sauvegardes automatiques (14 backups conservés)
├── youfind.db           # Base SQLite (créée automatiquement)
├── package.json
└── .env
```

### Base de données

`youfind.db` (SQLite, WAL mode) est créée automatiquement au premier lancement.

| Table | Contenu |
|---|---|
| `channels` | Chaînes YouTube (nom, ID, statut, abonnés, score LLM, miniature, description) |
| `videos` | Vidéos importées (titre, description, URL, durée, vues) |
| `topics` | Thèmes (nom, description, `display_order` pour le drag & drop) |
| `channel_topics` | Association chaîne ↔ thème (clé composite) |
| `feedback_log` | Historique des validations/rejets (utilisé dans le prompt LLM) |
| `settings` | Configuration clé-valeur |
| `watched_videos` | URLs des vidéos regardées (avec date) |
| `jobs` | Jobs asynchrones, progression, erreurs et résultats récupérables |
| `schema_migrations` | Historique des migrations d'infrastructure appliquées |
| `channels_fts` | Index full-text FTS5 (trigram tokenizer) pour la recherche de chaînes |
| `videos_fts` | Index full-text FTS5 pour la recherche de vidéos |

---

## API

Toutes les routes sont préfixées par `/api/`. Les réponses sont en JSON. Les tableaux ci-dessous donnent l'aperçu public ; l'inventaire technique complet, les statuts et les contrats de jobs sont maintenus dans [`agents/CONTRACTS.md`](agents/CONTRACTS.md).

### Statistiques & santé

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/stats` | Statistiques globales (canaux, vidéos, topics) |
| GET | `/rss-info` | Dernier refresh RSS (timestamp) |
| GET | `/llm-status` | Santé du LLM (provider, modèle, disponibilité) |

### Vidéos

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/videos` | Feed paginé (limit, offset, sort, topic, q) |
| GET | `/watched` | Liste des URLs regardées |
| POST | `/watched` | Marquer une URL comme vue |
| DELETE | `/watched` | Retirer une URL des vues |

### Chaînes

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/channels` | Liste (status, sort, scored/unscored, q, include) |
| POST | `/channels` | Ajouter une chaîne (nom + channel_id) |
| POST | `/channels/resolve` | Résoudre une URL/handle/recherche |
| POST | `/channels/import` | Import batch depuis du texte |
| POST | `/channels/refresh-stats` | Rafraîchir stats de toutes les chaînes |
| GET | `/refresh-stats/status` | Progression du refresh stats |
| POST | `/channels/:id/validate` | Valider une chaîne (+ auto-ingest vidéos) |
| POST | `/channels/:id/reject` | Rejeter une chaîne avec raison |
| POST | `/channels/:id/score` | Scorer une seule chaîne (LLM) |
| GET | `/channels/:id/detail` | Détail complet (vidéos récentes, similaires) |
| GET | `/channels/:id/related` | Chaînes similaires (scraping) |
| GET | `/channels/:id/preview` | 3 dernières vidéos (miniature) |

### Découverte

| Méthode | Chemin | Description |
|---|---|---|
| POST | `/discover` | Découverte par thème (retourne les chaînes trouvées) |
| POST | `/discover/related` | Démarrer l'exploration des similaires |
| GET | `/discover/related/status` | Progression + résultats en streaming (polling) |
| POST | `/discover/related/cancel` | Annuler l'exploration en cours |
| POST | `/discover/related/pause` | Pause / Reprendre |

### Jobs persistants

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/jobs/:id` | État d'un job, récupérable après un rechargement ou un redémarrage |

Les jobs de scoring et de découverte similaire sont enregistrés dans SQLite. Un job actif au moment d'un arrêt est marqué `interrupted` au prochain démarrage ; il n'est pas relancé automatiquement, car les appels externes ne sont pas nécessairement idempotents.

### Frontend modulaire

Les scripts frontend restent des scripts classiques (et non des modules ES) pour préserver les fonctions globales utilisées par les handlers inline de la SPA. L'ordre de chargement est `glob.constants.js`, `api.js`, `poller.js`, `glob.utils.js`, `core.js`, `stats.js`, `videos.js`, `settings.js`, puis `app.js`. Les constantes et helpers globaux sont donc disponibles avant les modules de page. Cette organisation permet d'extraire progressivement les pages sans changer les contrats HTML existants.

Le CSS est chargé via `style.css`, qui agit comme manifeste et importe `base.css`, `glob.utils.css`, puis les feuilles thématiques. `base.css` contient encore les fondations et une partie des styles historiques ; les nouveaux styles globaux vont dans `glob.utils.css`, tandis que les styles de page doivent être ajoutés dans la feuille thématique correspondante.

La suite de tests est volontairement sans réseau et sans base utilisateur. Voir [`agents/TESTING.md`](agents/TESTING.md) pour les conventions de fixtures, le smoke test et les priorités de couverture. Les documents techniques ont chacun une responsabilité unique afin d'éviter les divergences.

### Scoring

| Méthode | Chemin | Description |
|---|---|---|
| POST | `/score-all` | Scorer toutes les chaînes en attente |
| POST | `/score-unscored` | Scorer toutes les chaînes sans score |
| POST | `/rescore-all` | Reset + re-scorer toutes les chaînes |
| GET | `/score-status` | Progression du scoring (polling) |
| POST | `/score-cancel` | Annuler le scoring en cours |

### Vidéos (ingestion)

| Méthode | Chemin | Description |
|---|---|---|
| POST | `/refresh` | Rafraîchir les vidéos RSS des chaînes validées |
| GET | `/refresh/status` | Progression du refresh RSS |
| POST | `/refresh-videos` | Deep crawl vidéos de toutes les chaînes validées |
| POST | `/refresh-pending-videos` | Deep crawl des chaînes en attente sans vidéos |
| POST | `/ingest/:channelId` | Ingérer les vidéos d'une chaîne (30-100 vidéos) |
| POST | `/ingest/:channelId/deep` | Deep crawl complet (jusqu'à 500 vidéos) |

### Thèmes

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/topics` | Liste des thèmes (triés par ordre d'affichage) |
| POST | `/topics` | Créer un thème |
| PATCH | `/topics` | Réordonner les thèmes (body: `{ order: [{ id, display_order }] }`) |
| DELETE | `/topics?id=X` | Supprimer un thème |

### Configuration

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/settings` | Configuration publique (sans les secrets) |
| POST | `/settings` | Mettre à jour la configuration |
| GET | `/export` | Exporter la config complète (JSON) |
| POST | `/import` | Importer une config complète |
| GET | `/feedback` | Historique des validations/rejets |

---

## Utilisation rapide

1. **Ajoute des chaînes** → onglet **Chaînes** → **+**
   - Colle une URL YouTube, un handle (`@chaine`), ou du texte brut avec des liens
   - Le scraping résout tout automatiquement, gratuitement

2. **Valide les chaînes pertinentes** → onglet **Chaînes** → filtre « En attente »
   - Boutons vert/rouge ou **vue compacte + triage rapide** (Valider + suivant)
   - Les vidéos sont automatiquement aspirées à la validation

3. **Score avec le LLM** → onglet **Découvrir** → **Score all unscored**
   - Les notes t'aident à prioriser (vert = top, rouge = bof)
   - Ouvre la console (F12) pour voir pourquoi certaines chaînes échouent

4. **Découvre des chaînes similaires** → onglet **Similaires**
   - Sélectionne les statuts sources, choisis le nombre de passages
   - Résultats en direct, filtre français, pause/annule à tout moment

5. **Organise par thèmes** → onglet **Découvrir**
   - Crée des thèmes, glisse-dépose pour les réordonner
   - Les thèmes servent de favoris pour relancer des découvertes

6. **Regarde ton feed** → onglet **Vidéos**
   - Filtre par thème, trie par score, date ou vues
   - Marque les vidéos vues d'un clic sur l'œil

7. **Sauvegarde** → onglet **Réglages** → **Exporter (JSON)**
   - Sauvegarde tout : chaînes, thèmes, scores, vidéos vues
   - Réimporte sur une autre machine en un clic

---

## Avertissement

Ce logiciel est fourni à des fins éducatives et de curation personnelle. **Tu es seul responsable de l'utilisation que tu en fais.** Le scraping de YouTube peut violer les conditions d'utilisation de la plateforme. Les auteurs ne sauraient être tenus responsables de toute conséquence liée à l'utilisation de ce logiciel, y compris mais sans s'y limiter : la suspension de comptes YouTube, les atteintes aux droits d'auteur, ou toute violation des conditions d'utilisation de services tiers.

Ce projet n'est pas affilié à YouTube, Google ou Alphabet Inc.

---

## Licence

MIT — voir le fichier [LICENSE](LICENSE) pour le texte complet.

Copyright (c) 2024-2025 – YouFind contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
