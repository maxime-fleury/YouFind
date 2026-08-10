# Structure détaillée — YouFind

Catalogue technique destiné aux agents et contributeurs. `AGENTS.md` contient les règles courtes ; ce fichier décrit où se trouve chaque responsabilité.

> Mise à jour : 2026-08-10. Si un fichier est ajouté ou change de rôle, mettre à jour sa fiche ici.

## 1. Carte générale

```text
Bun
└── src/server.js
    ├── HTTP, routes et fichiers statiques
    ├── src/db.js                    SQLite, schéma et prepared statements
    ├── src/repositories/            (cible, pas encore entièrement extrait)
    ├── src/services/                (cible, pas encore entièrement extrait)
    ├── src/job-repository.js         jobs scoring/discovery persistés
    ├── src/rss.js                    ingestion et refresh vidéo
    ├── src/youtube-api.js            scraping/résolution YouTube
    ├── src/llm.js                   providers et scoring
    └── src/cron.js                   tâches planifiées

public/index.html
└── scripts classiques dans cet ordre
    api.js → poller.js → glob.utils.js → core.js → stats.js → videos.js → settings.js → app.js
```

### Frontières actuelles

Le projet est un monolithe local fonctionnel. Les frontières sont plus nettes côté adapters (`rss`, `youtube-api`, `llm`) et côté helpers/jobs, mais `server.js`, `db.js`, `app.js` et `base.css` restent des fichiers centraux.

### Architecture cible recommandée

```text
src/
├── http/          serveur, routeur, réponses, middleware
├── routes/        handlers minces par domaine
├── services/      cas métier et orchestration
├── repositories/  accès SQLite par agrégat
├── adapters/      YouTube, RSS, LLM
├── jobs/          runner, leases et handlers persistants
└── database/      connexion, migrations et FTS
```

Ne pas créer toute cette arborescence d’un coup : extraire une frontière avec ses tests à chaque étape.

## 2. Entrées, configuration et fichiers racine

| Fichier | Rôle | Points importants |
|---|---|---|
| `AGENTS.md` | Guide opérationnel court pour les agents IA. | Règles, commandes, checklist et liens vers ce catalogue. |
| `STRUCTURE.md` | Catalogue détaillé de l’architecture. | Une fiche par fichier ; mettre à jour lors des refactors. |
| `README.md` | Documentation utilisateur et développeur. | Installation, fonctionnalités, API, schéma et architecture publique. |
| `LICENSE` | Licence MIT. | Ne pas supprimer dans une redistribution. |
| `package.json` | Métadonnées et scripts Bun. | Entrée `src/server.js`; `bun test`; `bun run check`. |
| `bun.lock` | Lockfile de référence Bun. | Utiliser Bun pour les dépendances. |
| `package-lock.json` | Lockfile npm historique. | Non utilisé par les scripts ; ne pas le régénérer sans raison. |
| `tsconfig.json` | Configuration TypeScript/Bun. | `allowJs`, `strict`, `noEmit`; le code applicatif reste principalement JS. |
| `index.ts` | Exemple Bun historique. | N’est pas le point d’entrée de YouFind. |
| `.gitignore` | Fichiers locaux ignorés. | Couvre `.env`, logs, SQLite, WAL/SHM et backups. |
| `.env` | Configuration locale et secrets. | Non versionné ; ne jamais copier une clé dans la documentation. |

### Fichiers générés ou locaux

| Chemin | Rôle | Règle |
|---|---|---|
| `youfind.db` | Base SQLite utilisateur. | Ne pas modifier ou committer dans une tâche normale. |
| `youfind.db-wal` | Journal WAL SQLite. | Ne pas copier naïvement pour un backup. |
| `youfind.db-shm` | Mémoire partagée SQLite. | Généré automatiquement. |
| `backups/` | Backups créés par `src/backup.js`. | Données locales, ignorées. |
| `stdout.log`, `stderr.log`, `youfind-test.log` | Logs locaux éventuels. | Ne pas utiliser comme source de vérité ni les committer. |
| `.freebuff/desktop-v2.db*` | Métadonnées/base de l’environnement Freebuff. | Ne pas toucher sans demande explicite. |

## 3. Backend `src/`

### `src/server.js`

**Rôle :** point d’entrée Bun et façade HTTP actuelle.

**Contient :** configuration `PORT`/`HOST`/CORS, limite de taille JSON, rate limiting, serveur de fichiers, routes API déclaratives et dynamiques, SQL ponctuel, import/export, orchestration scoring/discovery/refresh, état des tâches et démarrage cron.

**Routes principales :**

- statistiques : `/api/stats`, `/api/dashboard`, `/api/rss-info`, `/api/llm-status` ;
- vidéos : `/api/videos`, `/api/watched` ;
- chaînes : `/api/channels`, résolution, import, validate/reject/score, detail, related, preview ;
- ingestion/refresh : `/api/ingest/*`, `/api/refresh*`, `/api/channels/refresh-stats` ;
- topics : `/api/topics`, `/api/channels/:id/topics` ;
- découverte : `/api/discover*` ;
- scoring/jobs : `/api/score-*`, `/api/rescore-all`, `/api/jobs/:id` ;
- settings/backup/feedback : `/api/settings`, `/api/export`, `/api/import`, `/api/feedback`.

**État important :** `isRefreshing*`, `isScoring`, `isRelatedRunning` et les trackers de progression sont en mémoire. Seuls scoring et related-discovery sont actuellement enregistrés dans `jobs`.

**À extraire ensuite :** `routes/*.routes.js`, `services/*.service.js`, puis les repositories. Une route devrait valider, appeler un service et formater une réponse ; elle ne devrait pas contenir une orchestration réseau + SQL complète.

### `src/db.js`

**Rôle :** connexion SQLite, bootstrap du schéma historique, FTS et registre de prepared statements.

**Initialisation :** ouvre `youfind.db`, active WAL/foreign keys, crée les tables, applique `ensureColumn`, lance `runMigrations`, installe les triggers FTS, répare les index et initialise les settings.

**Exports :** `db`, `stmts`, `getSetting`, `setSetting`, `getAllSettings`, `rebuildChannelsFts`.

**Contenu de `stmts` :** chaînes, vidéos, topics, feedback, statistiques, topics associés, vidéos vues, import/export.

**Risque :** importer ce fichier a des effets de bord. À terme, séparer `database/connection.js`, `database/schema.js`, `database/fts.js` et des repositories par domaine. Le schéma historique est encore migré ici en parallèle de `migrations.js`.

### `src/migrations.js`

**Rôle :** migrations versionnées de l’infrastructure jobs.

**Exports :** `runMigrations(database)`, `migrations`.

**Versions actuelles :**

- `1 persistent-jobs` : table `jobs` et index ;
- `2 persist-job-results` : colonne `jobs.results`.

Les migrations vérifient les versions futures, les noms incompatibles et appliquent chaque étape dans une transaction. La migration complète des anciennes tables n’est pas encore déplacée ici.

### `src/job-repository.js`

**Rôle :** persistance et lecture des jobs.

**Exports :** `createJob`, `getJob`, `updateJob`, `finishJob`, `recoverInterruptedJobs`, `JOB_STATUSES`, `JOB_TYPES`.

**Factory testable :** `createJobRepository(database)` permet d’utiliser `bun:sqlite` avec `:memory:`.

**Garanties :** normalisation JSON, limites sur erreurs/résultats, validation des types et statuts, marquage des jobs actifs en `interrupted` au démarrage.

**Limite :** pas encore de lease, `worker_id`, `cancel_requested` ni `job_items`.

### `src/job-utils.js`

**Rôle :** helpers purs pour les jobs et la progression.

**Exports :**

- `createJobId()` : identifiant temporel + aléatoire ;
- `createProgressTracker(fields)` : tracker avec valeurs initiales ;
- `resetProgressTracker(tracker, fields)` : réinitialisation en statut `running`.

Ne pas y ajouter de SQL ou de réseau.

### `src/http-helpers.js`

**Rôle :** validation HTTP indépendante du serveur.

**Exports :**

- `httpError(message, status)` ;
- `readJsonBody(req, maxBytes)` : JSON objet strict, erreurs `400`/`413` ;
- `parsePositiveId(value)` ;
- `isYoutubeChannelId(value)`.

Les tests associés sont dans `tests/http-helpers.test.js`.

### `src/utils.js`

**Rôle :** concurrence contrôlée.

**Export :** `runWithLimit(items, fn, limit, delayMs, options)`.

**Garanties :** limite de workers, ordre des résultats, délai entre tâches, arrêt sur erreur, annulation par `AbortSignal` et attente de tous les workers avant résolution/rejet.

### `src/backup.js`

**Rôle :** backup SQLite cohérent.

**Export :** `runBackup()`.

Utilise `VACUUM INTO`, crée `backups/`, vérifie le fichier produit et conserve au maximum 14 backups automatiques. Ne pas remplacer par une copie brute de `youfind.db` en mode WAL.

### `src/cron.js`

**Rôle :** planificateur mémoire.

**Exports :** `runRSSRefresh`, `runDiscovery`, `INTERVALS`, `startCron`, `getRSSInfo`, `markRSSLastRun`.

**Planification :** RSS toutes les 24 h, découverte tous les 3 jours, backup environ 30 secondes après le démarrage puis quotidiennement.

`taskState` et `nextRunAt` sont perdus au redémarrage. Le scheduling évite le chevauchement d’une même tâche en reprogrammant après la fin.

### `src/rss.js`

**Rôle :** adapter RSS et pipeline d’ingestion vidéo.

**Exports principaux :**

- `scrapeVideoDuration(videoUrl)` ;
- `fetchChannelFeed(channelId)` ;
- `ingestChannel(channelId, options)` ;
- `DEEP_REFRESH_MAX_VIDEOS` ;
- `deepIngestChannel(channelId)` ;
- `refreshAllVideos(onProgress)` ;
- `refreshPendingWithoutVideos(onProgress)` ;
- `refreshAllChannels(onProgress)` ;
- `getChannelVideoSummaries(channelId, count)`.

**Responsabilités :** parser XML RSS, fallback RSS après scraping, cache des durées, exclusion des Shorts, upsert vidéo, deep crawl, refresh global et limitation de concurrence.

`activeRefreshPromise` empêche deux refresh RSS globaux simultanés.

### `src/youtube-api.js`

**Rôle :** adapter YouTube sans API Data v3.

**Exports principaux :**

- `parseChannelInput(input)` ;
- `isShortByText(title, description)` ;
- `scrapeChannelInfo(channelId)` ;
- `scrapeChannelVideos(channelId, maxResults)` ;
- `resolveChannel(input)` ;
- `resolveFromVideoUrl(url)` ;
- `discoverFromTopic(query, maxResults, offset)` ;
- `scrapeDiscoverChannels(query, maxResults)` ;
- `scrapeRelatedChannels(channelId)` ;
- `discoverRelatedFromValidated(...)` ;
- `extractChannelIdsFromText(text)`.

**Responsabilités :** cache HTTP, timeout/retry/annulation, résolution ID/handle/recherche/vidéo, parsing `ytInitialData`/InnerTube, vidéos/durées/vues/dates, découverte et détection française.

**Risque :** les formats YouTube sont externes et instables. Les parseurs devraient être séparés et testés avec des fixtures HTML locales.

### `src/llm.js`

**Rôle :** clients providers + scoring LLM.

**Exports :** `scoreChannel`, `scoreAllPending`, `scoreAllUnscored`, `rescoreAllChannels`, `checkLLMHealth`.

**Fonctions internes importantes :** configuration provider, construction/troncature du prompt, appels Ollama/LM Studio/OpenRouter, propagation d’abort, parsing JSON équilibré, validation score `0..100`, assignation des topics.

**Règle métier :** une réponse LLM vide ou invalide ne doit pas supprimer les associations manuelles existantes.

À terme, séparer `adapters/llm/*`, `prompt-builder.js`, `response-parser.js` et `scoring-service.js`.

## 4. Frontend `public/`

### `public/index.html`

**Rôle :** document unique de la SPA.

Contient navbar, barre de statistiques, pages vidéos/chaînes/découverte/related/settings, modales de rejet/ajout/topics/détail, lecteur vidéo, footer et bouton retour haut.

Les handlers inline existent encore pour compatibilité. Toute donnée injectée dans ces handlers doit utiliser l’échappement adapté.

**Scripts chargés :** Bootstrap CDN, Mark.js CDN, puis `api.js`, `poller.js`, `glob.utils.js`, `core.js`, `stats.js`, `videos.js`, `settings.js`, `app.js`.

### `public/js/api.js`

**Rôle :** client HTTP global.

**Export global :** `api(path, options)`.

Ajoute `/api`, gère timeout, abort utilisateur, erreurs JSON, `422` et réponses `204`. Toute requête frontend normale doit passer par ce helper.

### `public/js/poller.js`

**Rôle :** polling générique des tâches longues.

**Exports globaux :** `waitFor(ms, signal)`, `pollJob(options)`.

Démarre un job, interroge son statut, avance avec `data.next`, tolère les erreurs transitoires, impose une deadline et reconnaît `done`, `cancelled`, `error`, `interrupted`.

### `public/js/glob.utils.js`

**Rôle :** utilitaires JavaScript transversaux chargés avant les pages.

**Fonctions importantes :** `formatNumber`, `formatDuration`, `formatDate`, `formatStatCount`, `escapeHtml`, `safeImageUrl`, `safeYoutubeThumbnailUrl`, `safeChannelId`, `extractVideoId`, `escapeJs`, `escapeInlineJs`, `downloadTextFile`, `csvEscape`, `showToast`.

Ce fichier ne doit pas dépendre d’une page. Il peut utiliser le DOM pour l’échappement et les toasts, mais ne doit pas contenir d’état métier, de requête API ou de logique SQLite.

### `public/js/core.js`

**Rôle :** fondations frontend chargées avant les pages.

**État global :** page courante, modales Bootstrap, état de recherche vidéo, prefetch, cache et état d’édition topics. Les utilitaires sans état sont dans `glob.utils.js`.

**Fonction importante :** `navigateTo`. Les fonctions de formatage, sécurité et toast sont centralisées dans `glob.utils.js`.

Il reste un script classique car l’HTML appelle des fonctions globales.

### `public/js/stats.js`

**Rôle :** page/dashboard statistiques.

**Fonctions importantes :** `renderStatsLoading`, `formatCountdown`, `formatTimeAgo`, `syncRssStats`, `updateRssCountdown`, `scheduleRssCountdown`, `loadStats`.

Gère les compteurs, le ratio validé, l’état RSS et le compte à rebours automatique.

### `public/js/videos.js`

**Rôle :** feed vidéo.

**Fonctions importantes :** `renderVideoCard`, `showVideoSkeletons`, `hideVideoSkeletons`, `debounceVideoSearch`, `loadVideos`, `prefetchNextPage`, `ensureVideoScrollTrigger`.

Utilise `IntersectionObserver`, le prefetch annulable et le cache des vidéos vues exposé par `app.js`.

### `public/js/settings.js`

**Rôle :** page de configuration LLM.

**Fonctions importantes :** `loadLLMHealth`, `loadSettings`, `saveSettings`, `testLLMConnection`, `toggleLLMFields`, `toggleSecret`, `clearSecret`, `updateSettingsStatus`.

Les helpers génériques comme `escapeInlineJs` viennent maintenant de `glob.utils.js`.

### `public/js/app.js`

**Rôle :** façade historique contenant les fonctionnalités frontend non encore extraites.

**Domaines présents :**

- chaînes : `loadChannels`, `searchChannels`, `renderChannels`, `renderCompactTable`, `exportChannels` ;
- découverte/topics : `loadTopics`, `discoverTopic`, `runDiscovery`, `addTopic`, `deleteTopic`, drag & drop ;
- scoring : `runScoreJob`, `scoreAll`, `scoreAllUnscored`, `rescoreAll`, `scoreSingle` ;
- actions chaînes : validation, rejet, aperçu, import batch et refresh ;
- topics chaîne : `openChannelTopics`, `renderChannelTopicEditor`, `saveChannelTopics` ;
- vidéos vues : `loadSeenVideos`, `getSeenVideos`, `markVideoSeen`, `unmarkVideoSeen`, `toggleVideoSeen` ;
- player : `loadYTAPI`, `openPlayer`, `closePlayer`, `playVideo` ;
- backup : `exportBackup`, `importBackup` ;
- related : `runRelatedDiscovery`, `cancelRelatedDiscovery`, `toggleRelatedPause`, `renderRelatedChannel` ;
- détail/triage : `openChannelDetail`, `showNextInQueue`, `acceptCurrentAndNext`, `openRejectAndNext`.

**État notable :** `_allChannels`, `_cachedTopics`, cache vidéos vues, `IntersectionObserver`, AbortControllers d’aperçu et de prefetch.

**Prochain découpage recommandé :** `channels.js`, `discover.js`, `related.js`, `player.js`, puis composants de rendu.

### `public/css/style.css`

**Rôle :** manifeste CSS, pas une feuille de règles complète.

Importe dans cet ordre : `base.css`, `glob.utils.css`, `videos.css`, `channels.css`, `topics.css`, `responsive.css`. L’HTML ne doit référencer que ce manifeste.

### `public/css/glob.utils.css`

**Rôle :** classes et animations transversales.

Contient les spinners, couleurs utilitaires, tailles de texte, badges génériques, transition de page, animation `pulse-new` et `glass-hover`. Les styles propres à une page doivent rester dans sa feuille thématique.

### `public/css/base.css`

**Rôle :** fondations et styles historiques partagés.

Contient variables de thème, ambiance dark/glassmorphism, boutons, formulaires, cartes, dashboard, cartes chaînes/vidéos, découverte, settings, modales, player, table compacte et règles encore non extraites.

C’est encore le plus gros fichier CSS ; les nouveaux styles spécifiques ne doivent pas y être ajoutés sans nécessité.

### `public/css/videos.css`

Filtres du feed vidéo, hover des miniatures, overlay de lecture, skeleton et animation du bouton refresh.

### `public/css/channels.css`

Styles de recherche locale des chaînes : icône, champ de recherche et surlignage `mark`.

### `public/css/topics.css`

Styles des badges topics, pills de sélection et liste du picker topics.

### `public/css/responsive.css`

Bouton retour haut, scrollbar, contraste Bootstrap et adaptations responsive communes aux pages.

### `public/favicon.svg`

Logo SVG utilisé par le favicon et la navbar. Pas de logique applicative.

## 5. Scripts et tests

### `scripts/backup-db.js`

Wrapper CLI minimal qui importe `runBackup()` depuis `src/backup.js`. Appelé par `bun run backup`.

### `scripts/score-rejected.js`

Commande ponctuelle : sélectionne les chaînes rejetées sans score puis appelle `scoreChannel` avec quatre workers et 500 ms de délai. Utilise la base réelle et ne passe pas par le moteur de jobs HTTP.

### `test-workflows.js`

Test d’intégration manuel contre `127.0.0.1:3002`. Crée et supprime des données, teste topics, chaînes, blacklist, découverte, vidéos, settings et dashboard. Ne fait pas partie de `bun test`.

### `tests/utils.test.js`

Tests de `runWithLimit` et `job-utils` : concurrence maximale, ordre, limite invalide, annulation, attente des workers, création/reset de tracker.

### `tests/jobs.test.js`

Tests SQLite `:memory:` : migrations idempotentes, historique incompatible, persistance de progression/résultats, filtre de type, récupération interrupted et statuts terminaux.

### `tests/http-helpers.test.js`

Tests du parsing JSON strict, taille maximale, IDs positifs et IDs YouTube.

**Tests manquants prioritaires :** fixtures YouTube/RSS/LLM, repositories de domaine, services métier et quelques tests HTTP d’intégration.

## 6. Données et invariants

### Chaînes

- `channels.id` est l’ID SQLite utilisé par `/channels/:id` ;
- `channels.channel_id` est l’ID YouTube unique `UC` + 22 caractères ;
- `status` vaut `pending`, `validated` ou `rejected` ;
- `llm_score` vaut `NULL` ou un nombre `0..100` ;
- `raison_rejet` est bornée côté API.

### Vidéos

- `url` est unique et sert à l’upsert ;
- `channel_id` référence l’identifiant YouTube, pas l’ID SQLite ;
- `duration` est en secondes ; `0` signifie inconnue ;
- le feed public filtre `duration > 60` ;
- une donnée existante non vide ne doit pas être remplacée par une valeur vide.

### Topics et feedback

- `topics.display_order` est l’ordre d’affichage ;
- `channel_topics` est une relation composite avec foreign keys ;
- `feedback_log` est un historique append-only qui alimente le prompt et la blacklist.

### Settings et secrets

`openrouter_key` ne doit jamais apparaître dans `/api/settings`, `/api/export`, les logs ou les fixtures. Les settings sont stockés comme chaînes clé/valeur.

### Jobs

Statuts autorisés : `queued`, `running`, `paused`, `done`, `error`, `cancelled`, `interrupted`. Les résultats et erreurs sont JSON bornés dans le repository.

### FTS5

- `videos_fts` indexe titre, description et nom de chaîne ;
- `channels_fts` utilise le tokenizer trigram ;
- les triggers synchronisent les modifications ;
- `rebuildChannelsFts()` répare l’index chaînes.

## 7. Flux principaux

### Ajout de chaîne

```text
public/js/app.js
  → api('/channels/resolve')
  → server.js
  → youtube-api.resolveChannel()
  → aperçu
  → api('/channels')
  → youtube-api.scrapeChannelInfo()
  → db.stmts.insertChannel
  → rss.ingestChannel() en arrière-plan
```

### Ingestion vidéo

```text
rss.ingestChannel()
  → youtube-api.scrapeChannelVideos()
  → fallback fetchChannelFeed()
  → filtre texte/durée Shorts
  → stmts.insertVideo upsert
  → triggers videos_fts
```

### Scoring

```text
POST /api/score-all
  → server.startScoringJob()
  → job-repository.createJob()
  → llm.scoreAllPending()
  → llm.scoreChannel()
  → provider LLM
  → parseLLMResponse()
  → updateChannelLLM + topics
  → updateJob/finishJob
  → public/js/poller.js
```

### Découverte similaire

```text
POST /api/discover/related
  → createJob()
  → youtube-api.discoverRelatedFromValidated()
  → callbacks de progression/résultats
  → jobs.results
  → polling since/next
  → ingestion des chaînes trouvées
```

## 8. Dette connue et ordre de refactor

1. Extraire `config`, réponses HTTP et routeur hors de `server.js`.
2. Extraire routes/services/repositories chaînes et vidéos.
3. Unifier migrations historiques et migrations jobs.
4. Créer un `JobRunner` commun avec lease, worker et annulation persistée.
5. Séparer clients réseau et parseurs YouTube/RSS/LLM avec fixtures.
6. Extraire `channels`, `discover`, `related` et `player` de `app.js`.
7. Déplacer progressivement les styles spécifiques hors de `base.css`.
8. Ajouter auth/CSP/validation SSRF si `HOST` doit écouter sur le réseau.

Ne pas faire de réécriture complète ni introduire un framework uniquement pour réduire la taille d’un fichier.
