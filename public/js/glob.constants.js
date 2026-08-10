// YouFind shared frontend constants.
// Loaded first so all classic scripts use the same names, limits, and timing policy.

const APP_PAGES = Object.freeze({
  VIDEOS: "videos",
  CHANNELS: "channels",
  DISCOVER: "discover",
  RELATED: "related",
  SETTINGS: "settings",
});

const DEFAULT_PAGE = APP_PAGES.VIDEOS;
const PAGE_NAMES = Object.freeze(Object.values(APP_PAGES));
const PAGE_STORAGE_KEY = "youfind-page";

const CHANNEL_STATUSES = Object.freeze({
  PENDING: "pending",
  VALIDATED: "validated",
  REJECTED: "rejected",
});

const JOB_STATUSES = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  PAUSED: "paused",
  DONE: "done",
  ERROR: "error",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
});

const FRONTEND_LIMITS = Object.freeze({
  VIDEO_PAGE_SIZE: 60,
  CHANNEL_RENDER_CAP: 200,
  REFRESH_STATS_MAX_FAILURES: 5,
  POLL_MAX_FAILURES: 10,
});

const FRONTEND_DELAYS = Object.freeze({
  API_TIMEOUT_MS: 60_000,
  CHANNEL_SEARCH_DEBOUNCE_MS: 150,
  VIDEO_SEARCH_DEBOUNCE_MS: 300,
  PREVIEW_DEBOUNCE_MS: 600,
  POLL_INTERVAL_MS: 1_000,
  POLL_RETRY_MS: 2_000,
  POLL_DEADLINE_MS: 2 * 60 * 60 * 1_000,
  REFRESH_POLL_INTERVAL_MS: 1_500,
  REFRESH_POLL_DEADLINE_MS: 30 * 60 * 1_000,
  REFRESH_BACKGROUND_INTERVAL_MS: 5_000,
  REFRESH_BACKGROUND_DEADLINE_MS: 2 * 60 * 60 * 1_000,
  REFRESH_BANNER_HIDE_MS: 3_000,
  REFRESH_TIMEOUT_HIDE_MS: 5_000,
  RSS_COUNTDOWN_INTERVAL_MS: 15_000,
  TOAST_DURATION_MS: 3_500,
  TOAST_FADE_MS: 300,
  DOWNLOAD_REVOKE_MS: 1_000,
});
