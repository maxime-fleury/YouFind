# Guide des agents IA — YouFind

Ce fichier est destiné aux agents IA qui interviennent sur YouFind. Il décrit le projet tel qu'il existe aujourd'hui, ses conventions, ses flux importants et les pièges à éviter.

> **Règle principale :** comprendre le flux existant avant de modifier le code. YouFind est une application locale fonctionnelle ; privilégier les changements ciblés et réversibles plutôt qu'une réécriture globale.

---

## 1. Résumé du projet

YouFind est une application locale de curation YouTube :

- ajout et résolution de chaînes YouTube ;
- ingestion de vidéos par scraping HTML et RSS ;
- validation, rejet et classement des chaînes ;
- organisation par topics ;
- recherche FTS5 de chaînes et de vidéos ;
- scoring LLM via Ollama, LM Studio ou OpenRouter ;
- découverte de chaînes par sujet ou chaînes similaires ;
- rafraîchissement automatique RSS, découverte et sauvegardes SQLite ;
- export/import complet de la base fonctionnelle.

Le projet n'utilise pas de framework frontend et n'utilise pas l'API YouTube Data v3. Il fonctionne avec Bun et SQLite.

### Choix techniques

| Domaine | Technologie | Raison |
|---|---|---|
| Runtime | Bun | Serveur HTTP, exécution JavaScript et SQLite natif |
| Backend | JavaScript ESM | Peu de dépendances et déploiement local simple |
| Base | SQLite en mode WAL | Adapté à une application monoposte locale |
| Recherche | SQLite FTS5 | Recherche rapide sans service externe |
| Frontend | Vanilla JavaScript | Pas de bundle ni framework à maintenir |
| Style | CSS custom + Bootstrap CDN | Interface dark/glassmorphism responsive |
| LLM | Ollama, LM Studio, OpenRouter | Providers locaux ou cloud configurables |
| Scraping | `fetch` + parsing HTML/RSS | Aucun quota YouTube Data API |

---

## 2. Commandes de développement

Le gestionnaire attendu est **Bun**. Ne pas remplacer les commandes par npm sans raison explicite.

```bash
bun install                 # Installer les dépendances selon bun.lock
bun run dev                 # Serveur Bun avec hot reload
bun run start               # Serveur normal
bun test                    # Tous les tests unitaires Bun
bun run check               # Vérification syntaxique backend et frontend
bun run refresh             # Refresh RSS manuel
bun run cron                # RSS + découverte manuels
bun run backup              # Sauvegarde SQLite manuelle
```

### Smoke test manuel

Lancer le serveur sur un port libre, puis tester au minimum :

```bash
PORT=32130 HOST=127.0.0.1 bun src/server.js
curl http://127.0.0.1:32130/api/stats
```

Routes utiles pour un smoke test :

- `GET /api/stats` → `200` ;
- `GET /api/channels` → `200` ;
- `GET /api/topics` → `200` ;
- `GET /api/export` → `200`, export version 2 ;
- JSON invalide sur une route POST → `400` ;
- `GET /api/jobs/missing` → `404`.

Le script `test-workflows.js` est un test d'intégration manuel destructif sur une base réelle : il crée un topic et une chaîne puis les manipule. Ne pas le lancer contre une base utilisateur sans sauvegarde et sans vérifier le port configuré.

### Règles Git pour les agents

- Inspecter `git status --short --branch` avant toute opération importante.
- Ne jamais écraser, stasher, réinitialiser ou supprimer les modifications d'un autre agent.
- Ne pas toucher aux bases `youfind.db*` ni aux fichiers `.freebuff/desktop-v2.db*` sauf demande explicite.
- Ne pas committer ou pousser sans demande explicite de l'utilisateur.
- Ne pas utiliser `git add -A` : sélectionner les fichiers du travail.
- Vérifier le diff et lancer les tests avant de proposer un commit.

---

## 3. Arborescence

```text
youfind/
├── AGENTS.md                 # Ce guide pour les agents IA
├── README.md                 # Documentation utilisateur et API
├── LICENSE                   # Licence MIT
├── package.json              # Scripts et configuration Bun/ESM
├── bun.lock                  # Verrouillage Bun, fichier de référence
├── package-lock.json         # Artefact npm historique, ne pas modifier sans raison
├── tsconfig.json             # Configuration TypeScript/Bun, même si le code applicatif est JS
├── index.ts                  # Petit exemple Bun historique, non utilisé par le serveur
├── .gitignore                # Fichiers ignorés
├── .env                      # Configuration locale, secrets ; ne jamais committer
├── src/                      # Backend et infrastructure
├── public/                   # SPA et assets statiques
├── scripts/                  # Commandes opérationnelles ponctuelles
├── tests/                    # Tests unitaires isolés
├── backups/                  # Sauvegardes générées, ignorées par Git
├── youfind.db*               # Base locale et fichiers WAL/SHM, ignorés par Git
├── stdout.log / stderr.log   # Logs locaux éventuels
└── .freebuff/                # Métadonnées de l'environnement de travail
```

---

## 4. Flux d'exécution

### Démarrage backend

```text
bun src/server.js
  ├── importe db.js
  │   ├── ouvre youfind.db
  │   ├── active WAL et foreign_keys
  │   ├── crée/complète le schéma historique
  │   ├── exécute migrations.js
  │   ├── installe les triggers/FTS
  │   └── prépare stmts
  ├── importe job-repository.js
  ├── marque les jobs actifs précédents comme interrupted
  ├── configure Bun.serve
  ├── sert les routes API
  ├── sert public/
  └── démarre le cron intégré
```

`src/db.js` a des effets de bord à l'import. Importer `db`, `stmts` ou `getSetting` ouvre donc une base et peut effectuer des opérations de schéma. Il faut en tenir compte dans les tests.

### Flux frontend

`public/index.html` charge les scripts dans cet ordre :

1. Bootstrap bundle CDN ;
2. Mark.js CDN ;
3. `public/js/api.js` ;
4. `public/js/poller.js` ;
5. `public/js/core.js` (état, navigation et utilitaires) ;
6. `public/js/stats.js` (dashboard et planning RSS) ;
7. `public/js/videos.js` (feed, pagination et prefetch) ;
8. `public/js/settings.js` (réglages LLM et secrets) ;
9. `public/js/app.js` (fonctionnalités restantes et façade de compatibilité).

Les scripts sont des scripts classiques, pas des modules ES. Les fonctions de `api.js`, `poller.js` et `app.js` sont donc accessibles globalement et les handlers HTML inline en dépendent.

Au chargement :

```text
app.js
  ├── charge les vidéos vues
  ├── restaure la page depuis localStorage
  ├── navigue vers la page courante
  ├── charge les statistiques
  ├── vérifie le LLM
  └── charge les topics
```

### Flux d'ajout d'une chaîne

```text
Frontend
  → POST /api/channels/resolve
  → resolveChannel() dans youtube-api.js
  → aperçu utilisateur
  → POST /api/channels
  → scrapeChannelInfo()
  → INSERT channels
  → ingestChannel() en arrière-plan
  → scraping YouTube puis fallback RSS
  → upsert videos
```

### Flux de scoring

```text
POST /api/score-unscored ou /api/score-all
  → création d'un job SQLite
  → scoreChannelList()
  → runWithLimit() avec concurrence configurable
  → appel LLM
  → parsing JSON de la réponse
  → mise à jour score et topics
  → progression en mémoire + SQLite
  → polling frontend /api/score-status
```

### Flux de découverte similaire

```text
POST /api/discover/related
  → création d'un job SQLite
  → sélection des chaînes par statut
  → workers YouTube avec AbortSignal
  → résultats incrémentaux
  → persistance dans jobs.results
  → polling avec curseur since/next
  → ingestion automatique des chaînes trouvées
```

---

## 5. Description de chaque fichier

## 5.1 Fichiers racine

### `AGENTS.md`

Guide destiné aux agents IA. Il doit être mis à jour lorsqu'une nouvelle convention, une nouvelle route importante ou un nouveau sous-système est ajouté.

### `README.md`

Documentation destinée aux utilisateurs et développeurs humains : concept, fonctionnalités, prérequis, installation, configuration, commandes, architecture, tables SQLite et routes API. Mettre à jour ce fichier lorsqu'une fonctionnalité publique ou une route change.

### `package.json`

Déclare :

- projet privé ESM (`"type": "module"`) ;
- entrée Bun `src/server.js` ;
- scripts `dev`, `start`, `refresh`, `cron`, `backup`, `check`, `test`.

Il n'y a actuellement pas de dépendance applicative déclarée dans `package.json`. Le lockfile Bun contient les outils de typage `@types/bun` et TypeScript. Bootstrap, Bootstrap Icons et Mark.js sont chargés par CDN dans `public/index.html`.

### `bun.lock`

Lockfile de référence pour Bun. Utiliser Bun pour installer ou modifier les dépendances.

### `package-lock.json`

Lockfile npm présent dans le dépôt mais non utilisé par les scripts actuels. Ne pas le mettre à jour avec une modification exclusivement Bun.

### `tsconfig.json`

Configuration TypeScript/Bun : `allowJs`, librairies ESNext, types Bun, résolution bundler, mode strict et `noEmit`. Le code applicatif est principalement JavaScript ; `tsc` n'est pas le check principal actuellement. `bun run check` utilise `node --check`.

### `index.ts`

Exemple Bun minimal :

```ts
console.log("Hello via Bun!");
```

Il ne participe pas au serveur YouFind. Ne pas le prendre comme point d'entrée de production.

### `.gitignore`

Ignore les dépendances, builds, logs, `.env`, caches, bases SQLite, WAL/SHM et backups. Une base locale peut rester présente dans le workspace sans devoir être commitée.

### `.env`

Configuration locale non versionnée. Variables principales :

- `PORT` ;
- `HOST` ;
- `CORS_ORIGIN` ;
- `LLM_PROVIDER` ;
- `LLM_CONCURRENCY` ;
- `OLLAMA_URL`, `OLLAMA_MODEL` ;
- `LMSTUDIO_URL`, `LMSTUDIO_MODEL` ;
- `OPENROUTER_KEY`, `OPENROUTER_MODEL`.

Ne jamais copier une clé dans un fichier versionné, un test, un log ou un export.

### `LICENSE`

Licence MIT du projet.

### `stdout.log`, `stderr.log`, `youfind-test.log`

Logs de développement éventuels. Ils ne constituent pas une source de vérité et ne doivent pas être ajoutés au code ou aux tests.

### `youfind.db`, `youfind.db-wal`, `youfind.db-shm`

Base SQLite locale, journal WAL et fichier de mémoire partagée. Ils sont générés par l'application et ignorés par Git. Les tests de repository doivent utiliser `:memory:` ou une base temporaire.

---

## 5.2 Backend `src/`

### `src/server.js`

Point d'entrée principal du backend Bun. C'est actuellement le fichier le plus central.

Responsabilités actuelles :

- configuration `PORT`, `HOST`, CORS et taille maximale JSON ;
- création de `Bun.serve` ;
- réponses JSON et fichiers statiques ;
- rate limiting en mémoire ;
- routes API ;
- validation de paramètres ;
- accès direct à `db`, `stmts` et SQL ponctuel ;
- orchestration scoring et découverte similaire ;
- état de progression en mémoire ;
- import/export ;
- démarrage du cron.

Routes principales :

- stats : `/api/stats`, `/api/dashboard`, `/api/rss-info`, `/api/llm-status` ;
- vidéos : `/api/videos`, `/api/watched` ;
- chaînes : `/api/channels`, résolution, import batch, validation, rejet, détail, related, preview ;
- ingestion : `/api/ingest/:channelId`, `/deep` ;
- refresh : `/api/refresh`, `/api/refresh-videos`, `/api/refresh-pending-videos` et leurs `/status` ;
- topics : `/api/topics`, topics d'une chaîne ;
- découverte : `/api/discover`, `/api/discover/related` et contrôle pause/annulation ;
- scoring : `/api/score-all`, `/api/score-unscored`, `/api/rescore-all`, `/api/score-status`, `/api/score-cancel` ;
- jobs : `/api/jobs/:id` ;
- settings : `/api/settings` ;
- sauvegarde : `/api/export`, `/api/import` ;
- feedback : `/api/feedback`.

**À éviter :** ajouter une nouvelle grosse route directement dans ce fichier sans extraire au minimum sa validation, sa logique métier ou son repository.

### `src/db.js`

Couche SQLite historique et registre de prepared statements.

Responsabilités :

- ouvre `youfind.db` à la racine ;
- active `journal_mode=WAL` et `foreign_keys=ON` ;
- crée les tables historiques ;
- ajoute certaines colonnes anciennes via `ensureColumn()` ;
- exécute `runMigrations()` pour l'infrastructure des jobs ;
- crée les index et triggers FTS5 ;
- répare ou reconstruit `channels_fts` si nécessaire ;
- initialise les settings par défaut ;
- exporte `db`, `stmts`, les helpers settings et `rebuildChannelsFts`.

Tables fonctionnelles :

- `channels` : chaînes et scores ;
- `videos` : vidéos ingérées ;
- `topics` : topics utilisateurs ;
- `channel_topics` : relation chaîne/topic ;
- `feedback_log` : décisions de validation/rejet ;
- `settings` : configuration clé/valeur ;
- `watched_videos` : vidéos vues ;
- `jobs` et `schema_migrations` : jobs persistants et migrations ;
- `videos_fts` et `channels_fts` : index de recherche.

`stmts` centralise beaucoup de requêtes mais n'est pas encore un ensemble de repositories par domaine.

### `src/migrations.js`

Système de migrations versionnées pour l'infrastructure des jobs.

Migrations actuelles :

- version 1 : création de `jobs` et de ses index ;
- version 2 : ajout de `jobs.results`.

`runMigrations(database)` :

1. crée `schema_migrations` ;
2. vérifie les versions futures inconnues ;
3. vérifie le nom des migrations déjà appliquées ;
4. applique chaque migration dans une transaction ;
5. enregistre la version appliquée.

La migration complète du schéma historique de `db.js` n'est pas encore déplacée ici.

### `src/job-repository.js`

Repository SQLite dédié aux jobs persistants.

Fonctions exportées :

- `createJob()` ;
- `getJob(id, expectedType)` ;
- `updateJob()` ;
- `finishJob()` ;
- `recoverInterruptedJobs()`.

Le factory `createJobRepository(database)` permet de tester le repository avec une base SQLite en mémoire. Les erreurs et résultats JSON sont bornés pour éviter une croissance illimitée.

Types actuellement acceptés : `scoring`, `related-discovery`.

### `src/job-utils.js`

Helpers sans accès réseau ni base :

- `createJobId()` ;
- `createProgressTracker()` ;
- `resetProgressTracker()`.

Ils sont adaptés aux tests unitaires et aux états de progression frontend/backend.

### `src/http-helpers.js`

Frontière de validation HTTP réutilisable :

- `httpError(message, status)` ;
- `readJsonBody(request, maxBytes)` ;
- `parsePositiveId(value)` ;
- `isYoutubeChannelId(value)`.

`readJsonBody` accepte un objet JSON, refuse les tableaux/primitives, et renvoie des erreurs `400` ou `413` explicites.

### `src/utils.js`

Contient `runWithLimit(items, fn, limit, delayMs, { signal })`.

Garanties importantes :

- concurrence maximale respectée ;
- résultats dans l'ordre d'entrée ;
- rejet si la limite est invalide ;
- arrêt sur erreur ;
- annulation par `AbortSignal` ;
- attente de tous les workers avant la résolution/rejection.

Tout nouveau traitement parallèle doit préférer ce helper à une nouvelle implémentation maison.

### `src/youtube-api.js`

Adapter YouTube sans clé API.

Responsabilités :

- interprétation des entrées chaîne/handle/URL vidéo ;
- résolution de chaîne ;
- cache mémoire des pages ;
- fetch avec timeout, retry et annulation ;
- parsing HTML `ytInitialData` ;
- extraction nom, description, miniature et abonnés ;
- extraction des vidéos, durées, vues et dates ;
- recherche par sujet ;
- chaînes similaires ;
- filtre des Shorts et chaînes françaises ;
- ingestion de résultats de découverte.

Le parsing dépend de structures internes YouTube (`ytInitialData`, InnerTube, textes localisés). Toute modification de parsing doit être accompagnée de fixtures HTML locales.

### `src/rss.js`

Pipeline d'ingestion et de refresh vidéo.

Responsabilités :

- parsing manuel du XML RSS YouTube ;
- fallback RSS lorsque le scraping HTML échoue ;
- cache des durées vidéo ;
- exclusion des Shorts par texte et durée ;
- ingestion/upsert des vidéos ;
- refresh rapide des chaînes validées ;
- deep refresh jusqu'à `DEEP_REFRESH_MAX_VIDEOS = 500` ;
- refresh des chaînes pending sans vidéos ;
- limitation de concurrence ;
- protection contre le chevauchement de deux refresh RSS via `activeRefreshPromise`.

`ingestChannel()` utilise 100 vidéos pour une nouvelle chaîne et environ 30 pour une chaîne déjà connue, sauf demande explicite de deep crawl.

### `src/llm.js`

Adapter et service de scoring LLM.

Responsabilités :

- lecture de la configuration provider ;
- construction et limitation des prompts ;
- appels Ollama, LM Studio et OpenRouter ;
- timeout de 120 secondes ;
- propagation de `AbortSignal` ;
- parsing de JSON brut ou fenced ;
- validation du score 0–100 ;
- mise à jour score/résumé ;
- association automatique de topics ;
- scoring d'une chaîne ou d'une liste ;
- diagnostic de santé des providers.

Une liste de topics vide ou invalide ne doit pas supprimer les associations manuelles existantes.

### `src/cron.js`

Planificateur mémoire :

- refresh RSS toutes les 24 heures ;
- découverte toutes les 3 jours ;
- backup quotidien environ 30 secondes après démarrage ;
- pas de chevauchement d'une même tâche, car la tâche suivante est programmée après la fin.

`taskState` et `nextRunAt` sont en mémoire. Ils sont perdus au redémarrage et ne constituent pas un historique durable.

### `src/backup.js`

Sauvegarde SQLite cohérente via `VACUUM INTO`.

- crée `backups/` si nécessaire ;
- produit un nom horodaté ;
- vérifie que le fichier existe et n'est pas vide ;
- conserve jusqu'à 14 backups automatiques ;
- ne supprime pas les snapshots manuels ne correspondant pas au pattern automatique.

Ne pas remplacer `VACUUM INTO` par une copie naïve de `youfind.db` en mode WAL.

---

## 5.3 Frontend `public/`

### `public/index.html`

Document HTML principal de la SPA.

Il contient :

- navigation globale ;
- barre de statistiques ;
- page vidéos ;
- page chaînes ;
- page découverte/topics/scoring ;
- page chaînes similaires ;
- page settings ;
- modales rejet, ajout, topics et détail chaîne ;
- lecteur vidéo ;
- footer et bouton retour haut.

Les handlers inline sont encore nombreux. Toute nouvelle donnée injectée dans ces handlers doit utiliser les helpers d'échappement de `app.js`.

### `public/css/style.css`

Manifeste CSS. Il importe `base.css`, puis les couches thématiques (`videos.css`, `channels.css`, `topics.css` et `responsive.css`) dans un ordre stable. Les pages doivent référencer ce fichier, pas les feuilles internes directement.

### `public/css/base.css`

Fondations et styles partagés conservés depuis l'ancien `style.css` : variables, ambiance, composants génériques, cartes, modales et styles de page encore non extraits. Les nouveaux styles transversaux vont ici uniquement s'ils sont réellement partagés.

### `public/css/videos.css`

Filtres du feed vidéo, overlay de lecture, hover des miniatures et skeleton de chargement.

### `public/css/channels.css`

Recherche et contrôles visuels propres à la page des chaînes.

### `public/css/topics.css`

Badges, pills et sélecteur de topics réutilisés par la découverte et les modales de chaînes.

### `public/css/responsive.css`

Bouton retour haut, scrollbar, contraste Bootstrap et adaptations responsive communes.

### `public/favicon.svg`

Logo SVG local de YouFind, utilisé comme favicon et logo de navigation.

### `public/js/api.js`

Client API global partagé.

- préfixe automatiquement les chemins par `/api` ;
- timeout configurable ;
- fusionne timeout interne et annulation utilisateur via `AbortController` ;
- parse les erreurs JSON ;
- traite les réponses `204`.

Utiliser `api()` au lieu de `fetch()` direct dans le frontend, sauf cas explicitement justifié.

### `public/js/poller.js`

Poller générique de jobs asynchrones.

- démarre un job par POST ;
- récupère `jobId` ;
- interroge un endpoint de statut ;
- gère un curseur `{cursor}` ou un générateur d'URL ;
- avance avec `data.next` pour éviter les doublons ;
- limite les erreurs réseau transitoires ;
- impose une deadline de deux heures ;
- reconnaît `done`, `cancelled`, `error` et `interrupted`.

Ne pas recréer une boucle de polling dans `app.js` si ce comportement peut être exprimé avec `pollJob()`.

### `public/js/core.js`

Fondations frontend chargées avant les pages : état global partagé, modales Bootstrap, navigation, formatage et toasts. Il reste volontairement un script classique afin de conserver les handlers inline et les fonctions globales existantes.

### `public/js/stats.js`

Module du dashboard : skeleton de chargement, compteurs, carte RSS et synchronisation du compte à rebours.

### `public/js/videos.js`

Module du feed vidéo : rendu des cartes, états de chargement, recherche, pagination infinie, prefetch et observation du scroll.

### `public/js/settings.js`

Module de la page Réglages : santé LLM, choix du provider, secrets OpenRouter, sauvegarde et test de connexion.

### `public/js/app.js`

Façade historique de la SPA, désormais réduite aux fonctionnalités restantes (chaînes, découverte, topics, scoring, import batch, chaînes similaires, détail et lecteur). Les sections extraites ne doivent pas être réintroduites ici.

- état global et navigation ;
- formatage, toasts et statistiques ;
- feed vidéos, pagination infinie et prefetch ;
- gestion des chaînes, recherche fuzzy et vue compacte ;
- découverte par sujet ;
- topics et drag & drop ;
- scoring et affichage de progression ;
- ajout et import batch de chaînes ;
- refresh RSS/vidéos/stats ;
- topics associés aux chaînes ;
- vidéos vues et fallback localStorage ;
- lecteur YouTube ;
- export/import ;
- settings LLM ;
- découverte de chaînes similaires ;
- détail de chaîne et workflow « valider + suivant » ;
- sanitization et validation d'URLs.

État notable :

- `currentPage` est sauvegardée dans `localStorage` ;
- `_allChannels` sert de cache de rendu ;
- `_cachedTopics` sert de cache des topics ;
- les requêtes d'aperçu chaîne sont protégées par séquence + AbortController ;
- le feed vidéos utilise `IntersectionObserver` et prefetch annulable ;
- les vidéos vues sont d'abord chargées depuis SQLite puis fallback localStorage.

Les fonctions de rendu utilisent beaucoup de templates `innerHTML`. Les valeurs externes doivent passer par `escapeHtml`, `safeImageUrl`, `safeYoutubeThumbnailUrl`, `safeChannelId` ou `escapeInlineJs` selon le contexte.

### `public/css/style.css`

Feuille de style principale, environ 2 100 lignes.

Elle définit :

- variables de thème violet/dark ;
- surfaces glassmorphism ;
- boutons et formulaires ;
- dashboard et statistiques ;
- cartes vidéos et chaînes ;
- badges de statut et scores LLM ;
- découverte, topics et progressions ;
- settings ;
- modales et lecteur YouTube ;
- table compacte ;
- drag & drop ;
- responsive mobile/tablette ;
- animations et `prefers-reduced-motion`.

Les styles contiennent encore quelques règles inline dans `index.html` et les templates JS. Éviter d'augmenter cette duplication.

---

## 5.4 Scripts opérationnels

### `scripts/backup-db.js`

Petit wrapper CLI qui importe `runBackup()` depuis `src/backup.js`. Utilisé par `bun run backup`.

### `scripts/score-rejected.js`

Script ponctuel qui récupère les chaînes rejetées sans score et les score avec quatre workers et 500 ms de délai. Il agit directement sur la base réelle et n'utilise pas le moteur de jobs HTTP.

À traiter comme une commande potentiellement longue et non idempotente.

### `test-workflows.js`

Test d'intégration manuel contre `http://127.0.0.1:3002`. Il vérifie notamment :

- stats ;
- création/suppression de topic ;
- ajout et rejet d'une chaîne ;
- respect de la blacklist ;
- découverte ;
- vidéos ;
- tri invalide ;
- settings ;
- santé LLM ;
- dashboard.

Ce fichier n'est pas inclus dans `bun test` et doit être lancé seulement avec une base de test ou une sauvegarde.

---

## 5.5 Tests

### `tests/utils.test.js`

Tests de `runWithLimit()` et des helpers de progression :

- limite de concurrence ;
- ordre des résultats ;
- limite invalide ;
- annulation et attente des workers ;
- création/reset de tracker.

### `tests/jobs.test.js`

Tests isolés avec `bun:sqlite` et bases `:memory:` :

- migrations idempotentes ;
- historique incompatible ou futur ;
- persistance de progression/résultats ;
- filtrage par type de job ;
- récupération des jobs interrompus ;
- statuts terminaux.

### `tests/http-helpers.test.js`

Tests de :

- parsing JSON objet ;
- JSON invalide ;
- refus des tableaux ;
- limite de taille ;
- parsing d'ID positif ;
- validation d'ID YouTube.

Les nouveaux tests backend doivent préférer des fonctions pures ou des factories avec base en mémoire. Éviter d'importer `src/server.js` dans un test unitaire car cela ouvre un serveur et une base réelle.

---

## 6. Modèle de données et invariants

### `channels`

- `id` : identifiant SQLite interne ; utilisé par les routes `/channels/:id`.
- `channel_id` : identifiant YouTube, unique, format `UC` + 22 caractères `[A-Za-z0-9_-]`.
- `status` : uniquement `pending`, `validated`, `rejected`.
- `llm_score` : score numérique 0–100 ou `NULL`.
- `raison_rejet` : texte borné côté API.

Ne pas confondre `id` et `channel_id` : la plupart des adapters externes utilisent `channel_id`, les actions d'interface utilisent `id`.

### `videos`

- `url` est unique et sert à l'upsert ;
- `channel_id` référence le `channel_id` YouTube de `channels` ;
- `duration` est en secondes ;
- le feed public filtre `duration > 60` ;
- une durée `0` signifie inconnue, pas forcément une vidéo courte ;
- les mises à jour n'écrasent pas les données existantes avec des valeurs vides.

### `topics` et `channel_topics`

- les topics ont un `display_order` ;
- `channel_topics` possède une clé composite ;
- les suppressions de topic doivent préserver l'intégrité via les foreign keys/cascade.

### `feedback_log`

Historique append-only des décisions de validation/rejet. Il alimente aussi le prompt LLM et la blacklist de chaînes rejetées.

### `settings`

Les settings sont des chaînes clé/valeur. Les clés publiques et secrètes sont filtrées dans `server.js`.

`openrouter_key` :

- ne doit jamais apparaître dans `/api/settings` ;
- ne doit jamais apparaître dans `/api/export` ;
- ne doit pas être affichée dans les logs ;
- n'est conservée qu'en base locale.

### `jobs`

Statuts : `queued`, `running`, `paused`, `done`, `error`, `cancelled`, `interrupted`.

Actuellement persistés :

- scoring batch ;
- découverte similaire.

Les refresh RSS/vidéo/stats restent principalement en mémoire et constituent une dette connue.

### FTS5

- `videos_fts` indexe titre, description et nom de chaîne ;
- `channels_fts` utilise le tokenizer trigram pour la recherche partielle ;
- les triggers synchronisent les changements ;
- `rebuildChannelsFts()` est disponible pour réparer l'index chaîne.

---

## 7. Contrats API importants

Toutes les routes sont sous `/api` et renvoient du JSON pour les routes applicatives.

### Lecture

```text
GET /api/stats
GET /api/dashboard
GET /api/videos?limit=&offset=&sort=&topic=&q=
GET /api/channels?status=&sort=&q=&include=topics,preview
GET /api/topics
GET /api/feedback?limit=
GET /api/settings
GET /api/export
GET /api/jobs/:id
```

### Mutations principales

```text
POST   /api/channels
POST   /api/channels/resolve
POST   /api/channels/import
POST   /api/channels/:id/validate
POST   /api/channels/:id/reject
POST   /api/channels/:id/score
POST   /api/channels/refresh-stats
POST   /api/ingest/:channelId
POST   /api/ingest/:channelId/deep
POST   /api/refresh
POST   /api/refresh-videos
POST   /api/refresh-pending-videos
POST   /api/discover
POST   /api/discover/related
POST   /api/discover/related/cancel
POST   /api/discover/related/pause
POST   /api/score-all
POST   /api/score-unscored
POST   /api/rescore-all
POST   /api/score-cancel
POST   /api/import
POST   /api/settings
POST/PATCH/DELETE /api/topics
POST/DELETE /api/watched
```

### Réponses de jobs

Les routes de démarrage de scoring/découverte renvoient généralement `202` :

```json
{
  "ok": true,
  "status": "running",
  "jobId": "..."
}
```

Pour la découverte similaire, le statut contient un curseur :

```json
{
  "jobId": "...",
  "status": "running",
  "results": [],
  "next": 0
}
```

Le frontend doit reprendre `next` comme valeur `since` suivante.

---

## 8. Règles de modification par domaine

### Backend

- utiliser `readBody`/`readJsonBody` pour les JSON ;
- valider les identifiants avant toute requête ;
- utiliser les prepared statements ou paramètres SQLite ;
- encapsuler les transitions multi-tables dans `db.transaction()` ;
- ne pas lancer une tâche longue de façon non suivie sans `catch` ;
- propager `AbortSignal` dans les nouveaux appels réseau ;
- utiliser `runWithLimit()` pour toute concurrence ;
- borner les tailles d'entrée, erreurs, prompts et résultats ;
- retourner des statuts HTTP cohérents (`400`, `404`, `409`, `413`, `202`) ;
- ne jamais exposer de secret dans une réponse ou un log.

### SQLite

- ne pas modifier directement `youfind.db` dans un test ;
- ajouter une migration pour toute modification durable de `jobs` ;
- pour le schéma historique, documenter toute modification de `db.js` ;
- respecter `foreign_keys=ON` ;
- vérifier les triggers FTS après toute modification de `channels` ou `videos` ;
- ne pas faire de copie fichier naïve d'une base WAL pour un backup.

### Scraping et réseau

- conserver des timeouts ;
- traiter `429` et `5xx` comme transitoires avec backoff borné ;
- ne pas augmenter la concurrence YouTube sans mesurer l'impact ;
- ne pas supposer que la structure HTML YouTube est stable ;
- ajouter une fixture pour chaque nouveau parseur ;
- éviter de loguer des pages ou réponses complètes potentiellement volumineuses.

### Frontend

- utiliser `api()` ;
- annuler les requêtes obsolètes lors des recherches/aperçus ;
- échapper tout texte venant du serveur avant `innerHTML` ;
- utiliser `safeImageUrl()` pour les images ;
- utiliser `safeChannelId()` pour les URLs de chaînes ;
- utiliser `escapeInlineJs()` uniquement pour les rares handlers inline existants ;
- éviter d'ajouter de nouvelles variables globales ;
- mettre à jour `AGENTS.md` et `README.md` si une route ou un flux change.

---

## 9. Risques connus et dette d'architecture

### Priorité haute

1. `server.js` combine HTTP, SQL et métier.
2. Les refresh RSS/vidéo/stats ne sont pas encore des jobs persistants génériques.
3. Le schéma historique est encore créé/migré dans `db.js` hors du système versionné.
4. Il n'y a pas de lease/worker id pour empêcher les doublons entre plusieurs processus.
5. La recherche chaînes charge encore de gros volumes et la pagination serveur est incomplète.

### Priorité moyenne

1. `app.js` reste un module global de presque 3 000 lignes.
2. Les adapters YouTube/RSS/LLM sont difficiles à tester sans fixtures.
3. Le parsing RSS/XML et YouTube est principalement manuel.
4. Les logs ne sont pas structurés et il n'y a pas de correlation id.
5. Les tests frontend et tests HTTP d'intégration sont limités.

### Priorité sécurité

1. L'application est conçue pour `127.0.0.1`, pas pour une exposition réseau sans auth.
2. La CSP est absente et les handlers inline sont nombreux.
3. Les assets Bootstrap/Mark.js viennent de CDN.
4. Les URLs de providers LLM sont configurables ; une validation SSRF serait nécessaire en mode réseau.
5. `x-forwarded-for` ne doit être utilisé que derrière un proxy de confiance.

---

## 10. Feuille de route recommandée

### Étape 1 — Extraire les frontières backend

Créer progressivement :

```text
src/routes/channels.routes.js
src/routes/videos.routes.js
src/routes/jobs.routes.js
src/routes/topics.routes.js
src/services/channel-service.js
src/services/ingestion-service.js
src/services/scoring-service.js
src/repositories/channel-repository.js
src/repositories/video-repository.js
```

Chaque extraction doit conserver les contrats JSON existants et être accompagnée d'un test.

### Étape 2 — Généraliser le moteur de jobs

Ajouter :

- `job_items` ;
- `worker_id` et lease ;
- annulation persistée ;
- reprise idempotente ;
- jobs pour RSS, ingestion, refresh stats et backup ;
- historique des jobs côté UI.

### Étape 3 — Unifier les adapters

Séparer :

```text
fetch réseau → parsing → normalisation → service métier → repository
```

Créer des fixtures et une politique réseau commune : timeout, retry, backoff, `Retry-After`, limite de concurrence.

### Étape 4 — Découper le frontend

Migrer progressivement vers des modules ES vanilla :

```text
public/js/core/store.js
public/js/pages/videos.js
public/js/pages/channels.js
public/js/pages/discover.js
public/js/pages/related.js
public/js/pages/settings.js
public/js/components/*.js
```

Remplacer les handlers inline par délégation d'événements, puis ajouter une CSP stricte.

### Étape 5 — Durcir l'exploitation

- validation de configuration au démarrage ;
- auth optionnelle si `HOST` n'est pas local ;
- CSP et dépendances frontend locales ;
- logs structurés ;
- commande de restauration/test de backup ;
- métriques de durée et d'erreurs des adapters.

---

## 11. Checklist avant de terminer une tâche

### Compréhension

- [ ] `git status` lu et fichiers préexistants identifiés ;
- [ ] flux d'appel concerné compris ;
- [ ] contrat API et invariants vérifiés ;
- [ ] aucune dépendance nouvelle utilisée sans vérifier l'existant.

### Implémentation

- [ ] validation des entrées présente ;
- [ ] accès SQL paramétré ;
- [ ] transaction utilisée pour les écritures liées ;
- [ ] timeout/annulation présents pour le réseau ;
- [ ] secrets exclus des réponses et logs ;
- [ ] pas de modification volontaire de la base utilisateur ;
- [ ] documentation mise à jour si le comportement public change.

### Vérification

- [ ] `bun test` ;
- [ ] `bun run check` ;
- [ ] `git diff --check` ;
- [ ] smoke test API si le backend est touché ;
- [ ] revue du diff et des fichiers nouvellement créés ;
- [ ] absence de logs de debug ou secrets ;
- [ ] statut Git final expliqué à l'utilisateur.

---

## 12. Résumé opérationnel pour un nouvel agent

1. Lire ce fichier puis `README.md`.
2. Lancer `git status --short --branch`.
3. Identifier le domaine concerné : chaînes, vidéos, topics, jobs, LLM ou frontend.
4. Lire le fichier d'entrée (`server.js` ou `app.js`) et le module appelé avant d'éditer.
5. Préférer une extraction ciblée à une nouvelle logique inline.
6. Écrire un test isolé dès qu'une logique pure, une migration ou un repository est modifié.
7. Utiliser Bun, pas npm, pour les vérifications.
8. Ne pas faire de réseau réel dans les tests unitaires.
9. Lancer `bun test`, `bun run check` et `git diff --check`.
10. Résumer précisément les fichiers modifiés, les vérifications et les limites restantes.
