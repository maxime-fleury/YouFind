# Guide des agents IA — YouFind

Ce fichier donne les règles de travail rapides. Pour le rôle précis de **chaque fichier**, ses fonctions importantes, ses dépendances et les flux, lire [`STRUCTURE.md`](STRUCTURE.md).

## 1. Projet en une phrase

YouFind est une application locale Bun + SQLite + frontend vanilla qui collecte des chaînes YouTube, ingère leurs vidéos, les organise par topics et utilise éventuellement un LLM pour les scorer.

Choix structurants :

- Bun et JavaScript ESM côté serveur ;
- SQLite en mode WAL, sans ORM ;
- scraping YouTube/RSS sans YouTube Data API ;
- frontend sans framework ni bundler ;
- scripts frontend classiques chargés par ordre dans `public/index.html` ;
- jobs de scoring et de découverte persistés dans SQLite, mais refresh RSS/stats encore principalement en mémoire.

## 2. Première lecture obligatoire

Avant de modifier quoi que ce soit :

1. lire `STRUCTURE.md` ;
2. lire la section du domaine concerné ;
3. exécuter `git status --short --branch` ;
4. identifier les modifications préexistantes ;
5. vérifier le contrat API ou l’invariant SQLite concerné.

Ne pas relire tout le dépôt à chaque tâche : `STRUCTURE.md` sert d’index pour aller directement au bon fichier.

## 3. Commandes officielles

Le projet utilise **Bun** :

```bash
bun install
bun run dev
bun run start
bun test
bun run check
bun run refresh
bun run cron
bun run backup
```

Vérification minimale avant de terminer une modification :

```bash
bun test && bun run check && git diff --check
```

Smoke test backend :

```bash
PORT=32130 HOST=127.0.0.1 bun src/server.js
curl http://127.0.0.1:32130/api/stats
```

Le test `test-workflows.js` est manuel et modifie une vraie base. Ne pas le lancer contre une base utilisateur sans sauvegarde.

## 4. Règles Git et fichiers locaux

- inspecter `git status` avant toute opération importante ;
- ne jamais écraser, stasher, reset, supprimer ou committer les changements d’un autre agent ;
- ne pas modifier `youfind.db*`, `backups/` ou `.freebuff/desktop-v2.db*` sauf demande explicite ;
- ne jamais committer `.env`, une clé API, une base locale ou un log ;
- ne pas utiliser `git add -A` : sélectionner les fichiers concernés ;
- ne pas committer ou pousser sans demande explicite ;
- avant un commit demandé, relire le diff et l’historique récent ;
- expliquer en fin de tâche les fichiers modifiés, les tests et les changements restants.

## 5. Règles d’architecture

### Backend

- `src/server.js` est un point de composition historique ; éviter d’y ajouter une grosse logique métier ;
- extraire progressivement les routes vers `src/routes/`, les cas métier vers `src/services/` et le SQL vers `src/repositories/` ;
- utiliser `readJsonBody()`/`readBody()` pour les payloads JSON ;
- valider les IDs et statuts avant toute écriture ;
- utiliser des paramètres SQLite ou des prepared statements, jamais de concaténation de valeurs utilisateur ;
- utiliser une transaction pour une transition multi-tables ;
- propager `AbortSignal` à tout nouvel appel réseau ;
- utiliser `runWithLimit()` pour la concurrence ;
- borner les payloads, prompts, erreurs et résultats persistés ;
- ne jamais renvoyer ou journaliser un secret.

### Jobs

Le repository de jobs est réutilisable et testable avec SQLite en mémoire. Les nouveaux traitements longs doivent être conçus pour rejoindre un `JobRunner` commun plutôt que de créer un nouveau booléen global dans `server.js`.

Statuts autorisés : `queued`, `running`, `paused`, `done`, `error`, `cancelled`, `interrupted`.

### Scraping et LLM

Séparer mentalement :

```text
client réseau → parser → normalisation → service métier → repository
```

Les parseurs YouTube, RSS et LLM doivent être testables avec des fixtures locales, sans réseau réel.

### Frontend

Ordre de chargement dans `public/index.html` :

```text
api.js → poller.js → glob.utils.js → core.js → stats.js → videos.js → settings.js → app.js
```

Les scripts sont classiques pour conserver les handlers HTML inline existants. Toute donnée injectée dans `innerHTML` doit être échappée avec le helper adapté (`escapeHtml`, `safeImageUrl`, `safeChannelId`, `escapeInlineJs`). Utiliser `api()` au lieu d’un `fetch()` direct.

Le CSS est chargé via `public/css/style.css`, manifeste qui importe `base.css` puis les feuilles thématiques.

## 6. Carte rapide par tâche

| Besoin | Fichiers à lire en premier |
|---|---|
| Ajouter/modifier une route | `src/server.js`, puis `STRUCTURE.md` ; extraire si possible |
| Chaînes | `src/server.js`, `src/db.js`, `src/youtube-api.js`, `public/js/app.js` |
| Vidéos/ingestion | `src/rss.js`, `src/youtube-api.js`, `src/db.js`, `public/js/videos.js` |
| Scoring LLM | `src/llm.js`, `src/job-repository.js`, `public/js/settings.js`, `public/js/app.js` |
| Découverte | `src/youtube-api.js`, `src/server.js`, `public/js/app.js` |
| Job/polling | `src/job-repository.js`, `src/job-utils.js`, `public/js/poller.js` |
| Schéma SQLite | `src/db.js`, `src/migrations.js`, `STRUCTURE.md` |
| Utilitaires frontend globaux | `public/js/glob.utils.js`, `public/css/glob.utils.css` |
| Interface vidéos | `public/js/videos.js`, `public/css/videos.css` |
| Interface chaînes/topics | `public/js/app.js`, `public/css/channels.css`, `public/css/topics.css` |
| Réglages | `public/js/settings.js`, `src/server.js` |
| Sauvegarde | `src/backup.js`, `scripts/backup-db.js` |

## 7. Documentation à maintenir

- `README.md` : installation, fonctionnalités et contrats visibles par l’utilisateur ;
- `AGENTS.md` : règles courtes et workflow des agents ;
- `STRUCTURE.md` : catalogue des fichiers, fonctions importantes, flux et dette technique.

Mettre à jour `STRUCTURE.md` lorsqu’un fichier est créé, supprimé, renommé ou change de responsabilité. Une fiche doit rester courte : rôle, entrées/sorties, fonctions importantes et pièges.

## 8. Checklist finale

- [ ] état Git initial et fichiers externes identifiés ;
- [ ] contrat API et invariants vérifiés ;
- [ ] validation et SQL paramétré ;
- [ ] transaction utilisée si nécessaire ;
- [ ] timeout/annulation présents pour le réseau ;
- [ ] secrets absents des réponses, logs et exports ;
- [ ] test isolé ajouté si une logique pure/repository/migration change ;
- [ ] `bun test` passé ;
- [ ] `bun run check` passé ;
- [ ] `git diff --check` passé ;
- [ ] documentation mise à jour ;
- [ ] statut Git final expliqué.
