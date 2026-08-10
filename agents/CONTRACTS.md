# Contracts guide

This file records behavior that refactors must preserve.

## HTTP conventions

- API paths are served under `/api`.
- JSON requests use `Content-Type: application/json`.
- `readJsonBody()` accepts an object, rejects malformed JSON and arrays/primitives.
- Invalid JSON/validation generally returns `400`.
- Oversized JSON returns `413`.
- Missing resources return `404`.
- Conflicting long-running jobs return `409`.
- Long-running job starts return `202` or a job identifier according to the existing route.
- Successful empty mutations may return `204`.
- JSON responses must not expose secrets.

## Main routes

### Read routes

```text
GET /api/stats
GET /api/dashboard
GET /api/rss-info
GET /api/llm-status
GET /api/videos?limit=&offset=&sort=&topic=&q=
GET /api/channels?status=&sort=&q=&include=topics,preview
GET /api/topics
GET /api/feedback?limit=
GET /api/settings
GET /api/export
GET /api/jobs/:id
```

### Channel and ingestion mutations

```text
POST /api/channels
POST /api/channels/resolve
POST /api/channels/import
POST /api/channels/:id/validate
POST /api/channels/:id/reject
POST /api/channels/:id/score
POST /api/channels/refresh-stats
POST /api/ingest/:channelId
POST /api/ingest/:channelId/deep
POST /api/refresh
POST /api/refresh-videos
POST /api/refresh-pending-videos
```

### Discovery, scoring, and controls

```text
POST /api/discover
POST /api/discover/related
GET  /api/discover/related/status
POST /api/discover/related/cancel
POST /api/discover/related/pause
POST /api/score-all
POST /api/score-unscored
POST /api/rescore-all
POST /api/score-cancel
```

### Topics, settings, watched, backup

```text
POST/PATCH/DELETE /api/topics
POST/DELETE /api/watched
POST /api/settings
POST /api/import
POST /api/feedback
```

## Job contract

A job response contains a stable identifier and status. Typical start response:

```json
{
  "ok": true,
  "jobId": "...",
  "status": "running"
}
```

Allowed statuses:

```text
queued | running | paused | done | error | cancelled | interrupted
```

The frontend poller:

- starts the job with `POST`;
- polls until terminal state;
- advances `state.cursor` from `data.next`;
- tolerates transient failures up to its configured limit;
- recognizes `done` and `cancelled` as returned terminal results;
- turns `error` and `interrupted` into an error.

Related discovery may return incremental `results` plus `next`. Never remove cursor progression or the UI can duplicate results.

## Frontend loading contract

Classic script order is part of the contract:

```text
glob.constants.js → api.js → poller.js → glob.utils.js → core.js → stats.js → videos.js → settings.js → app.js
```

Inline HTML handlers depend on global functions such as `navigateTo`, `loadVideos`, `loadChannels`, `runDiscovery`, and scoring/related controls. Preserve those names until event delegation replaces the handlers.

## Data safety contract

Before using `innerHTML`:

- text → `escapeHtml()`;
- image URL → `safeImageUrl()`;
- YouTube/channel identifier → `safeChannelId()`;
- inline handler value → `escapeInlineJs()` with the HTML attribute context;
- external URL → validate protocol and expected host.

Use `api()` for frontend requests so timeout and user cancellation are cleaned up consistently.

## Secret contract

`openrouter_key`:

- may be stored in SQLite and read by the server;
- must not appear in `/api/settings`;
- must not appear in exports, logs, fixtures, or frontend HTML;
- is changed through the settings endpoint without echoing its value.

## Compatibility checklist

When changing a route or job:

- preserve method and path;
- preserve request field names;
- preserve status code semantics;
- preserve terminal job statuses;
- preserve error shape `{ error: string }` where currently used;
- update `README.md`, this file, and tests;
- add a migration if persistence changes.
