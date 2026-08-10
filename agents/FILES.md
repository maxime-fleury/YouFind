# File catalogue

Paths are relative to the repository root. Read this file before opening large modules.

## Root

| File | Responsibility |
|---|---|
| `README.md` | User-facing features, installation, configuration, API overview. |
| `AGENTS.md` | Short rules and workflow for AI agents. |
| `STRUCTURE.md` | Documentation index. |
| `TESTING.md` | Pointer to the detailed testing guide. |
| `agents/` | Focused agent documentation; see `agents/README.md`. |
| `package.json` | Bun scripts and syntax-check file list. |
| `bun.lock` | Bun dependency lockfile. |
| `package-lock.json` | Historical npm lockfile; do not regenerate casually. |
| `tsconfig.json` | Bun/TypeScript settings; code is mostly JavaScript. |
| `.gitignore` | Local databases, secrets, logs, backups, and dependencies. |
| `.env` | Local configuration and secrets; never commit. |
| `index.ts` | Historical Bun example, not the application entry point. |
| `LICENSE` | MIT license. |

## Backend `src/`

### Runtime and persistence

- `server.js`: Bun entry point, static files, API routes, validation, direct SQL, imports/exports, refresh/scoring/discovery orchestration, cron startup. Main God Object; extract before adding large features.
- `db.js`: opens `youfind.db` at import time; enables WAL/foreign keys; bootstraps legacy tables; creates FTS/triggers; initializes settings; exposes `db`, `stmts`, and settings helpers. Import has side effects.
- `migrations.js`: versioned `jobs` infrastructure migrations and `schema_migrations`; currently only part of the schema migration story.
- `job-repository.js`: testable SQLite repository for `scoring` and `related-discovery`; create/read/update/finish/recover operations.
- `job-utils.js`: pure job IDs and progress tracker helpers.
- `http-helpers.js`: JSON body parsing, positive integer IDs, YouTube channel ID validation, typed HTTP errors.
- `utils.js`: `runWithLimit()` with bounded concurrency, ordering, delay, abort, and worker cleanup.
- `backup.js`: SQLite `VACUUM INTO` backup and automatic rotation.
- `cron.js`: in-memory RSS/discovery/backup scheduler; schedule state is lost on restart.

### External adapters and parsers

- `youtube-api.js`: YouTube HTTP cache, retries, timeout/abort, channel resolution, HTML/InnerTube extraction, discovery, and related-channel orchestration. Re-exports pure parsers for compatibility.
- `youtube-parsers.js`: pure `parseChannelInput`, `isShortByText`, and `extractChannelIdsFromText`; no DB/network.
- `rss.js`: RSS/scrape ingestion, duration lookup, video upsert, refresh and deep crawl orchestration.
- `rss-parser.js`: pure XML RSS `parseEntries`; no DB/network.
- `llm.js`: provider configuration, prompt construction, Ollama/LM Studio/OpenRouter calls, response parsing, topic assignment, scoring workers, health checks. Highest-value missing pure parser extraction.

## Frontend `public/`

- `index.html`: single SPA document, inline handlers, modals, page containers, script order.
- `js/glob.constants.js`: global page names, statuses, limits, polling and UI delays. Load first.
- `js/api.js`: global `api()` client with `/api` prefix, timeout, abort cleanup, JSON errors, and `204` handling.
- `js/poller.js`: global `pollJob()` and `waitFor()` for long-running jobs and cursor progression.
- `js/glob.utils.js`: formatting, sanitization, safe URLs, CSV/download helpers, and toasts.
- `js/core.js`: global state, Bootstrap modals, navigation, page validation, and initialization.
- `js/stats.js`: dashboard stats and RSS countdown.
- `js/videos.js`: video card rendering, search debounce, pagination, prefetch, and infinite scroll.
- `js/settings.js`: LLM settings, secret handling, health check, save/test/reset.
- `js/app.js`: remaining channels, discovery, topics, scoring, watched videos, player, backup, related, triage. Next extraction target.

## CSS

- `css/style.css`: manifest only; imports the CSS files in stable order.
- `css/glob.utils.css`: shared utilities, badges, spinners, animations.
- `css/base.css`: variables, foundations, shared components, and legacy page styles; still too large.
- `css/videos.css`: video filters/cards/loading specifics.
- `css/channels.css`: channel search specifics.
- `css/topics.css`: topic badges/picker specifics.
- `css/responsive.css`: responsive and cross-page rules.

## Scripts and tests

- `scripts/backup-db.js`: CLI wrapper for `runBackup()`.
- `scripts/score-rejected.js`: real-database one-off scorer; not an isolated test.
- `test-workflows.js`: manual destructive integration workflow; never run casually against user data.
- `tests/`: automated tests; all current tests are offline or use in-memory SQLite.
- `tests/utils.test.js`: concurrency and job utility tests.
- `tests/jobs.test.js`: in-memory migration/repository tests.
- `tests/parsers.test.js`: offline YouTube/RSS fixture tests.
- `tests/http-helpers.test.js`: strict JSON and identifier tests.

## Common pitfalls

- `channels.id` is a SQLite ID; `channels.channel_id` is the YouTube ID.
- `videos.channel_id` references the YouTube ID, not `channels.id`.
- `duration` is seconds; public video feeds filter `duration > 60`.
- `openrouter_key` must never appear in responses, exports, logs, or fixtures.
- Do not import `db.js` in pure parser tests.
- Do not copy a WAL database as a backup; use the backup module.
- Preserve classic-script order and inline handler compatibility.
- Route declarations are split between the `Bun.serve({ routes })` block and manual `fetch()` branches in `src/server.js`; inspect both before changing an endpoint.
