# Architecture decisions

This file records decisions that are easy to lose when implementation details change. It is not a backlog and it must not duplicate the source code.

## ADR-001 — Local-first runtime

**Decision:** YouFind runs as a single local Bun process with SQLite storage.

**Why:** The application manages personal curation data and should work without a hosted backend, account system, ORM, or mandatory paid service.

**Consequences:**

- `src/db.js` opens the local database and has import-time side effects;
- backups and migrations are application responsibilities;
- adding authentication or multi-user access is a product/security change, not a simple middleware refactor;
- a future network-facing deployment needs an explicit threat model, authentication, CSRF protection, and secret policy.

## ADR-002 — No YouTube Data API

**Decision:** YouTube data is collected through HTML/InnerTube scraping and public RSS feeds.

**Why:** Avoid API keys, quotas, and recurring external costs.

**Consequences:**

- YouTube markup is an unstable external contract;
- adapters need timeout, retry, abort, bounded concurrency, and defensive parsing;
- pure parsers belong in separate files and must be tested with local fixtures;
- a parser failure should not be hidden as a database or HTTP failure.

## ADR-003 — Classic frontend scripts for compatibility

**Decision:** Frontend files remain classic scripts loaded in an explicit order instead of ES modules for now.

**Why:** `public/index.html` still contains inline handlers calling global functions.

**Consequences:**

- `glob.constants.js` must load before every consumer;
- `api.js`, `poller.js`, and `glob.utils.js` form shared infrastructure;
- new globals should be avoided and page state should move into future modules;
- event delegation and removal of inline handlers are prerequisites for a strict CSP and a future ES-module migration.

## ADR-004 — Persist only the long-running jobs that need recovery

**Decision:** Scoring and related discovery use the SQLite `jobs` table. Some RSS, stats, and cron operations still use in-memory state.

**Why:** Persistent job infrastructure was introduced for operations with user-visible progress, cancellation, and reload/restart recovery without prematurely generalizing every task.

**Consequences:**

- `jobs` is not a universal task queue;
- an active persisted job becomes `interrupted` after restart and is not automatically replayed;
- new long-running workflows should reuse the repository and move toward a shared runner instead of adding another process-global boolean;
- leases, worker identity, persistent cancellation, and item-level progress are intentionally future work.

## ADR-005 — Hybrid schema during incremental migration

**Decision:** Keep the legacy bootstrap in `src/db.js` while versioned job migrations live in `src/migrations.js`.

**Why:** The application already has user databases created before the migration system; a single risky rewrite could break existing data.

**Consequences:**

- every durable schema change must be evaluated against both files;
- do not add an untracked `ALTER TABLE` to a route or service;
- add a numbered migration and an isolated test for new durable changes;
- consolidating the schema is a planned refactor, not a prerequisite for ordinary feature work.

## ADR-006 — Pure parsing before persistence

**Decision:** External payload parsing is separated from network orchestration and SQLite writes where practical.

**Why:** Parser behavior is deterministic, high-risk, and cheap to test offline.

**Consequences:**

```text
network adapter → pure parser → normalized data → service/workflow → repository
```

The same boundary should be applied to the LLM response parser and future HTML adapters. Pure modules must not import `src/db.js`, access the DOM, or perform network requests.

## ADR-007 — Documentation has one owner per concern

**Decision:** Keep a short root index and focused documents under `agents/`.

**Ownership:**

- `README.md`: user-facing installation and feature overview;
- `AGENTS.md`: operational rules for agents;
- `agents/FILES.md`: file responsibilities and exports;
- `agents/ARCHITECTURE.md`: boundaries and flows;
- `agents/DATABASE.md`: schema and persistence invariants;
- `agents/CONTRACTS.md`: HTTP, jobs, and frontend compatibility;
- `agents/TESTING.md`: test strategy and isolation;
- `agents/DECISIONS.md`: rationale and trade-offs;
- `STRUCTURE.md`: navigation only.

When two documents appear to conflict, verify the implementation first, then update the document that owns the concern instead of copying another description.

## Review rule

Before changing an accepted decision, write down:

1. the problem that makes the current decision insufficient;
2. the compatibility and migration impact;
3. the tests and documentation that will change;
4. the rollback or recovery path.

Do not introduce a framework, a queue, an ORM, or a module-system rewrite solely to make a file shorter.
