# YouFind agent guide

This is the short entrypoint for AI agents. Detailed notes live in [`agents/`](agents/).

## Read first

1. [`agents/README.md`](agents/README.md) — documentation map;
2. [`agents/FILES.md`](agents/FILES.md) — file ownership and exports;
3. [`agents/ARCHITECTURE.md`](agents/ARCHITECTURE.md) — boundaries and flows;
4. [`agents/DATABASE.md`](agents/DATABASE.md) — SQLite schema and invariants;
5. [`agents/CONTRACTS.md`](agents/CONTRACTS.md) — HTTP/jobs/frontend contracts;
6. [`agents/TESTING.md`](agents/TESTING.md) — tests and fixtures.

`STRUCTURE.md` and `TESTING.md` at the root remain compatibility indexes for tools and humans.

## Project in one sentence

YouFind is a local Bun + SQLite + vanilla frontend application that collects YouTube channels, ingests videos, organizes topics, and optionally scores channels with an LLM.

## Before coding

- run `git status --short --branch`;
- identify pre-existing changes, especially `.freebuff/desktop-v2.db*`;
- preserve public routes, JSON fields, job statuses, and classic-script globals;
- read the relevant file guide before editing a large module;
- choose or add a test before changing a testable boundary.

## Architecture rules

- do not add another large workflow to `src/server.js`;
- prefer `route → service → repository/adapter`;
- keep pure parsing free of SQLite, DOM, and network;
- use prepared statements and transactions for related writes;
- propagate `AbortSignal` and use bounded concurrency for network work;
- never expose `openrouter_key` in responses, exports, logs, or fixtures;
- use `api()` in the frontend;
- escape every external value before `innerHTML` or inline handlers;
- preserve the script order in `public/index.html`.

## Commands

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

Final validation:

```bash
bun test && bun run check && git diff --check
```

Use a local port for a server smoke test:

```bash
PORT=32140 HOST=127.0.0.1 bun src/server.js
curl http://127.0.0.1:32140/api/stats
```

`test-workflows.js` is manual and mutates a real database. Do not run it casually.

## Git and local data

- do not use `git add -A`;
- do not overwrite, reset, stash, commit, or delete another agent’s changes;
- never commit `.env`, databases, WAL/SHM files, logs, or secrets;
- do not commit or push unless explicitly requested;
- review the diff and recent log before a requested commit;
- explain modified files, checks, remaining risks, and final Git status.

## Documentation rule

When a file, route, schema, job, or test boundary changes, update the matching document in `agents/`. Keep each document under roughly 500 lines and avoid duplicating implementation code.
