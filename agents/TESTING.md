# Testing guide

## Commands

```bash
bun test
bun run check
git diff --check
```

Standard final check:

```bash
bun test && bun run check && git diff --check
```

Smoke test with a free local port:

```bash
PORT=32140 HOST=127.0.0.1 bun src/server.js
curl -i http://127.0.0.1:32140/api/stats
```

Stop the server after testing. Do not run this against a shared production database.

## Current test layers

- `tests/utils.test.js`: concurrency, cancellation, and job utilities;
- `tests/http-helpers.test.js`: strict JSON and identifiers;
- `tests/jobs.test.js`: in-memory migrations and job repository;
- `tests/parsers.test.js`: pure YouTube/RSS fixtures;
- smoke tests: server startup, API stats, and static assets;
- `test-workflows.js`: manual destructive workflow, excluded from `bun test`;
- documentation checks: links, ownership, and the roughly 500-line limit per Markdown file.

`bun run check` is an explicit syntax-check list. When a JavaScript module is added or renamed, update `package.json`; do not assume the command covers every file automatically.

## Isolation rules

- no real network in unit tests;
- no real `youfind.db` or `.freebuff/desktop-v2.db*` in tests;
- use `:memory:` for SQLite repositories/migrations;
- do not import `src/db.js` from a pure parser test because import opens the user database;
- no secrets, cookies, tokens, or private data in fixtures;
- avoid exact-time assertions and uncontrolled randomness;
- use deterministic fixtures and bounded timers.

## Fixture rules

A fixture should cover a nominal case, an incomplete case, and a malformed/limit case. Keep it minimal:

```text
external input → pure parser → normalized value
```

Put large fixtures in `tests/fixtures/`, document their origin, and remove secrets. Do not copy full external pages when a small representative fragment is enough.

## Test by change type

| Change | Minimum coverage |
|---|---|
| Pure helper/parser | nominal, invalid input, boundary |
| Migration | first run, idempotence, mismatch/future version |
| Repository | create/read/update, missing row, bounds, transaction |
| HTTP route | valid/invalid body, status, JSON shape, redaction |
| Job/poller | progress, error, cancel, interruption, timeout |
| Network adapter | 2xx, 429, 5xx, timeout, abort, fixture parsing |
| Frontend rendering | empty data, escaping, stale request, cancellation |
| Asset/CSS | syntax and HTTP `200` |

## Priority gaps

1. Extract and test the LLM response parser: fenced JSON, balanced JSON, invalid scores, unknown topics, oversized text, empty/truncated output.
2. Add an HTTP harness with a temporary database for channels, topics, jobs, import/export, and `400/404/409/413/202` behavior.
3. Inject a mockable HTTP client into YouTube/RSS/LLM adapters for retry and abort tests.
4. Add browser tests for page navigation, script order, polling cursors, stale searches, and HTML escaping.

## Failure diagnosis

1. Run only the failing test.
2. Confirm it does not touch network or user data.
3. Check timer cleanup, abort handling, dates, and race conditions.
4. Read the implementation diff before weakening an assertion.
5. Fix the contract or code, then run the full suite.

## Documentation validation

For documentation-only changes, verify:

```bash
for f in README.md AGENTS.md STRUCTURE.md TESTING.md agents/*.md; do
  test "$(wc -l < "$f")" -lt 500 || exit 1
done
grep -R -n -E '\]\([^)]*\)' README.md AGENTS.md STRUCTURE.md TESTING.md agents
```

Then check that each link points to a tracked file or a documented external URL. Keep root files as indexes; do not copy the complete file catalogue, route list, schema, or test strategy into them.

## Definition of done

- nominal and relevant invalid/boundary behavior is covered;
- tests are deterministic and isolated;
- `bun test` passes;
- `bun run check` passes;
- `git diff --check` passes;
- docs and fixtures are updated when a boundary changes;
- documentation ownership is respected and every Markdown file remains under roughly 500 lines.
