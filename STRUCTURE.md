# YouFind structure index

The detailed agent documentation is split into focused files under [`agents/`](agents/). This file intentionally stays short so it remains a fast entrypoint.

## Documentation map

| Document | Use it for |
|---|---|
| [`AGENTS.md`](AGENTS.md) | First instructions and project rules. |
| [`agents/README.md`](agents/README.md) | Map of all agent documents and update policy. |
| [`agents/FILES.md`](agents/FILES.md) | Role, exports, dependencies, and pitfalls for each file. |
| [`agents/ARCHITECTURE.md`](agents/ARCHITECTURE.md) | Current boundaries, flows, and refactor roadmap. |
| [`agents/DATABASE.md`](agents/DATABASE.md) | Tables, relations, indexes, FTS, migrations, and SQLite safety. |
| [`agents/CONTRACTS.md`](agents/CONTRACTS.md) | HTTP, jobs, frontend loading, escaping, and secret contracts. |
| [`agents/TESTING.md`](agents/TESTING.md) | Test layers, fixtures, isolation, and coverage priorities. |
| [`agents/DECISIONS.md`](agents/DECISIONS.md) | Architectural rationale and trade-offs. |
| [`TESTING.md`](TESTING.md) | Compatibility pointer to the detailed testing guide. |

## Runtime map

```text
public/index.html
  → glob.constants.js → api.js → poller.js → glob.utils.js
  → core.js → stats.js → videos.js → settings.js → app.js
  → /api → src/server.js
                    ├── src/db.js / SQLite / FTS
                    ├── src/youtube-api.js + youtube-parsers.js
                    ├── src/rss.js + rss-parser.js
                    ├── src/llm.js
                    ├── src/job-repository.js
                    └── src/cron.js
```

## Current architectural warning

The application is a local, working monolith. `src/server.js`, `src/db.js`, `public/js/app.js`, and `public/css/base.css` still contain multiple responsibilities. Refactor incrementally and preserve existing contracts; do not rewrite the application solely to reduce line count.

## Source-of-truth rules

- user-facing behavior and installation: `README.md`;
- agent workflow: `AGENTS.md` and `agents/`;
- API/job behavior: `agents/CONTRACTS.md` plus route implementation;
- SQLite behavior: `agents/DATABASE.md` plus `src/db.js`/`src/migrations.js`;
- tests: `agents/TESTING.md` plus the actual test files;
- architectural rationale: `agents/DECISIONS.md`.

Update the relevant focused document when a responsibility changes. Keep documentation factual and under roughly 500 lines per file. `STRUCTURE.md` is an index, not a second file catalogue.
