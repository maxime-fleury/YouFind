# Agent documentation index

This directory contains focused technical notes for AI agents working on YouFind. Keep every document short, factual, and close to the code.

## Read by task

| Task | Start here |
|---|---|
| Any code change | `../AGENTS.md`, then the relevant file guide |
| File ownership and exports | `FILES.md` |
| Architecture or refactor | `ARCHITECTURE.md` |
| SQLite, migrations, FTS, backups | `DATABASE.md` |
| HTTP/frontend contracts | `CONTRACTS.md` |
| Tests and fixtures | `TESTING.md` |

## Document ownership

- `../README.md`: user-facing installation and feature documentation.
- `../AGENTS.md`: short operational rules and the first instructions for agents.
- `../STRUCTURE.md`: navigation index only.
- `../TESTING.md`: short compatibility pointer.
- `FILES.md`: file-by-file responsibility catalogue.
- `ARCHITECTURE.md`: current boundaries, flows, and refactor direction.
- `DATABASE.md`: database source of truth and invariants.
- `CONTRACTS.md`: HTTP, jobs, and frontend/backend contracts.
- `TESTING.md`: test policy, fixtures, isolation, and coverage gaps.

## Update policy

When a file is added, removed, renamed, or changes responsibility:

1. update `FILES.md`;
2. update `ARCHITECTURE.md` if a boundary changes;
3. update `CONTRACTS.md` if a public route or payload changes;
4. update `DATABASE.md` for schema/index/migration changes;
5. update `TESTING.md` when the test strategy changes.

Do not copy entire implementations into documentation. Document role, inputs, outputs, invariants, and sharp edges.
