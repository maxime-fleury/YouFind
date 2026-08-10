# Architecture guide

## Current shape

YouFind is a local Bun + SQLite monolith with a vanilla JavaScript frontend.

```text
Browser
  classic scripts → api.js → Bun HTTP server
                              ├── SQLite / FTS
                              ├── YouTube adapter
                              ├── RSS adapter
                              ├── LLM providers
                              └── in-memory cron and some refresh state
```

The main coupling points are:

- `src/server.js` (~1,500 lines): routing, validation, SQL, orchestration, static files, jobs, and cron startup;
- `src/db.js` (~500 lines): connection side effects, legacy schema bootstrap, FTS, settings, and prepared statements;
- `public/js/app.js` (~2,100 lines): channels, discovery, topics, scoring, player, backup, and triage;
- `public/css/base.css` (~1,800 lines): shared and still-unclassified page styles.

Do not rewrite these files wholesale. Extract one stable boundary at a time and preserve API/HTML contracts.

## Risk map

| Area | Risk | Why it matters | First safe move |
|---|---|---|---|
| `src/server.js` | High | HTTP, SQL, network, jobs, and static files share one process boundary. | Add route/service tests, then extract one domain without changing paths. |
| `src/db.js` | High | Import opens the user database and mixes bootstrap, migrations, FTS, settings, and statements. | Keep `:memory:` repository tests and move one schema concern behind a tested boundary. |
| `public/js/app.js` | Medium-high | Many global functions and page states are coupled through inline HTML handlers. | Extract one page domain while preserving global wrappers. |
| External adapters | High | YouTube, RSS, and LLM formats can change or hang. | Inject/mock clients and test retry, abort, and parser boundaries. |
| Documentation | Medium | README and technical guides can drift when they duplicate route/schema details. | Keep ownership explicit and update the focused document, not every index. |

## Desired dependency direction

```text
HTTP route
  → application service
    → repository / adapter
      → SQLite or external network
```

Rules:

- routes validate and format responses; they should not own long SQL/network workflows;
- services own business transitions and orchestration;
- repositories own SQL and transactions;
- adapters own network protocols and retries;
- parsers normalize external text without network or database dependencies;
- pure modules must be tested without importing `src/db.js`.

## Existing boundaries

- `src/http-helpers.js`: strict JSON and route identifier validation;
- `src/job-repository.js`: persistent scoring/discovery job state;
- `src/job-utils.js`: pure job progress helpers;
- `src/youtube-parsers.js`: pure YouTube input and link parsing;
- `src/rss-parser.js`: pure RSS entry parsing;
- `public/js/glob.constants.js`: frontend page/status/limit/timing constants;
- `public/js/glob.utils.js`: frontend formatting, sanitization, and export helpers;
- `public/css/style.css`: CSS manifest;
- `agents/DECISIONS.md`: rationale for the local-first, classic-script, hybrid-migration, and parser-boundary choices.

## Main flows

### Add a channel

```text
frontend
  → POST /api/channels/resolve
  → YouTube resolution adapter
  → user preview
  → POST /api/channels
  → channel persistence
  → background ingestion
  → YouTube scrape, RSS fallback, video upsert
```

### Video ingestion

```text
rss.ingestChannel()
  → scrapeChannelVideos()
  → RSS fallback when needed
  → remove Shorts
  → upsert videos by unique URL
  → FTS triggers
```

### LLM scoring

```text
POST /api/score-all or /api/score-unscored
  → persistent job
  → bounded workers
  → prompt + provider call
  → response parser
  → score/topic update
  → job progress + frontend polling
```

### Related discovery

```text
POST /api/discover/related
  → persistent job
  → selected channel statuses
  → bounded YouTube workers
  → French-channel filter
  → insert result before notifying UI
  → cursor-based polling
```

## Frontend loading order

These are classic scripts, not ES modules, because HTML still calls global functions inline:

```text
glob.constants.js
→ api.js
→ poller.js
→ glob.utils.js
→ core.js
→ stats.js
→ videos.js
→ settings.js
→ app.js
```

Do not move a shared declaration after a script that uses it. Avoid new global variables; put constants in `glob.constants.js` and page state in the future page module.

## Refactor roadmap

1. Extract HTTP response helpers and a small router from `server.js`.
2. Extract channel/video routes, services, and repositories while preserving JSON responses.
3. Move all legacy schema evolution out of `db.js` into versioned migrations.
4. Generalize `JobRunner` for RSS, refresh stats, ingestion, scoring, and discovery.
5. Add leases, worker identity, persistent cancellation, and idempotent resume.
6. Extract remaining YouTube/LLM parsers and add local fixtures.
7. Split `app.js` into channels, discovery, related, player, and backup modules.
8. Remove inline handlers gradually, then introduce a stronger CSP.
9. Add a lightweight documentation drift check for file links, route inventory, and the Markdown line limit.

Avoid adding a framework solely to reduce file length.
