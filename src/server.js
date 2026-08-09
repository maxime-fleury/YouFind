import { join, dirname, resolve, relative } from "path";
import { db, stmts, getSetting, setSetting, getAllSettings, rebuildChannelsFts } from "./db.js";
import { ingestChannel, refreshAllChannels, refreshAllVideos, refreshPendingWithoutVideos, deepIngestChannel } from "./rss.js";
import { discoverFromTopic, resolveChannel, scrapeChannelInfo, resolveFromVideoUrl, scrapeRelatedChannels, extractChannelIdsFromText, discoverRelatedFromValidated } from "./youtube-api.js";
import { scoreChannel, scoreAllPending, scoreAllUnscored, rescoreAllChannels, checkLLMHealth } from "./llm.js";
import { runWithLimit } from "./utils.js";
import { createJobId, createProgressTracker, resetProgressTracker } from "./job-utils.js";
import { startCron, getRSSInfo, markRSSLastRun } from "./cron.js";

// ═══ CONFIG ═══
const PORT = parseInt(Bun.env.PORT || "3000");
const HOST = Bun.env.HOST || "127.0.0.1";

// ═══ HTTP HELPERS ═══
const CORS_ORIGIN = Bun.env.CORS_ORIGIN || `http://${HOST}:${PORT}`;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
};
// Backups can legitimately contain the full local video catalog.
const MAX_JSON_BODY_BYTES = 128 * 1024 * 1024;

const SETTINGS_KEYS = new Set([
  "llm_provider",
  "ollama_url", "ollama_model",
  "lmstudio_url", "lmstudio_model",
  "openrouter_key", "openrouter_model",
  "llm_concurrency",
]);
const SECRET_SETTINGS = new Set(["openrouter_key"]);

function getPublicSettings() {
  const settings = getAllSettings();
  const publicSettings = {};
  for (const key of SETTINGS_KEYS) {
    if (!SECRET_SETTINGS.has(key)) publicSettings[key] = settings[key];
  }
  for (const key of SECRET_SETTINGS) {
    publicSettings[`${key}_configured`] = Boolean(settings[key]);
  }
  return publicSettings;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function readBody(req) {
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    const error = new Error("Request body too large");
    error.status = 413;
    throw error;
  }
  try {
    const text = await req.text();
    if (text.length > MAX_JSON_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.status === 413) throw error;
    return {};
  }
}

// ═══ STATIC FILE SERVING ═══
const ROOT_DIR = dirname(import.meta.dir);
const PUBLIC_DIR = resolve(join(ROOT_DIR, "public"));

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(pathname) {
  const filePath = resolve(join(PUBLIC_DIR, pathname));
  const rel = relative(PUBLIC_DIR, filePath);
  if (rel.startsWith("..") || rel === "" || rel.startsWith("/") || rel.startsWith("\\")) {
    return null;
  }
  const file = Bun.file(filePath);
  if (file.size > 0) {
    const ext = filePath.substring(filePath.lastIndexOf("."));
    const isStaticAsset = ext !== ".html";
    return new Response(file, {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": isStaticAsset ? "public, max-age=86400" : "no-cache",
        ...CORS_HEADERS,
      },
    });
  }
  return null;
}

// ═══ SHARED STATE (mutable, accessed by route handlers) ═══
let isRefreshingRSS = false;
let isRefreshingVideos = false;
let isRefreshingPendingVideos = false;
let isRefreshingStats = false;
let isScoring = false;
let scoringJobId = null;
const scoringProgress = createProgressTracker({ jobId: null, mode: "", scored: 0, failed: 0, failures: [], error: "" });
let isRelatedRunning = false;
let relatedJobId = null;
let relatedAbortController = null;
let relatedPaused = false;
const refreshProgress = createProgressTracker({ errors: 0 });
const refreshVideosProgress = createProgressTracker({ errors: 0 });
const pendingVideosProgress = createProgressTracker({ errors: 0 });
const refreshStatsProgress = createProgressTracker();
const relatedProgress = createProgressTracker({ found: 0, results: [], error: "" });

// ═══ RATE LIMITER ═══
// Simple in-memory rate limiter: 120 requests per minute per IP
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60 * 1000;
const rateMap = new Map();

// Prune stale rate-limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, entries] of rateMap) {
    const recent = entries.filter((t) => t > cutoff);
    if (recent.length === 0) rateMap.delete(ip);
    else rateMap.set(ip, recent);
  }
}, 5 * 60 * 1000).unref();

function checkRateLimit(req) {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";
  const now = Date.now();
  const entries = rateMap.get(ip) || [];
  const windowStart = now - RATE_WINDOW_MS;
  const recent = entries.filter((t) => t > windowStart);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  rateMap.set(ip, recent);
  return true;
}

// ═══ SCORING JOB HELPERS ═══
async function runScoringJob(job) {
  if (isScoring) {
    return json({ error: "A scoring job is already in progress" }, 409);
  }
  isScoring = true;
  try {
    return await job();
  } finally {
    isScoring = false;
  }
}

function startScoringJob(mode, scorer) {
  if (isScoring) return null;

  isScoring = true;
  scoringJobId = createJobId();
  resetProgressTracker(scoringProgress, {
    jobId: scoringJobId,
    mode,
    scored: 0,
    failed: 0,
    failures: [],
    error: "",
  });

  Promise.resolve()
    .then(() => scorer((progress) => {
      scoringProgress.total = progress.total;
      scoringProgress.completed = progress.completed;
      scoringProgress.scored = progress.scored;
      scoringProgress.failed = progress.failed;
      scoringProgress.failures = progress.failures || [];
      scoringProgress.current = progress.current || "";
    }))
    .then((results) => {
      scoringProgress.status = "done";
      scoringProgress.total = Math.max(scoringProgress.total, scoringProgress.completed);
      scoringProgress.completed = scoringProgress.total;
      scoringProgress.scored = results.length;
    })
    .catch((err) => {
      scoringProgress.status = "error";
      scoringProgress.error = err.message;
      console.error(`[LLM] ${mode} scoring error:`, err.message);
    })
    .finally(() => {
      isScoring = false;
    });

  return scoringJobId;
}

// ═══ VALIDATION HELPERS ═══
function parsePositiveId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isYoutubeChannelId(value) {
  return typeof value === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(value.trim());
}

// ═══════════════════════════════════════════
//  ROUTE HANDLERS
// ═══════════════════════════════════════════
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  routes: {
    "/api/stats": {
      GET: () => {
        const stats = stmts.getStats.get();
        return json({
          ...stats,
          rss: getRSSInfo(),
          refreshRunning: refreshProgress.status === "running",
        });
      },
    },

    "/api/videos": {
      GET: (req) => {
        const url = new URL(req.url);
        const requestedLimit = Number(url.searchParams.get("limit") || "60");
        const offset = Number(url.searchParams.get("offset") || "0");
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || !Number.isInteger(offset) || offset < 0) {
          return json({ error: "limit must be >= 1 and offset must be >= 0" }, 400);
        }
        const limit = Math.min(requestedLimit, 100);
        const channel = url.searchParams.get("channel");
        const topic = url.searchParams.get("topic");
        const search = url.searchParams.get("q")?.trim() || "";
        // Build a safe prefix-match FTS5 query: term1* AND term2*
        const rawTerms = search
          .replace(/['"]/g, "")
          .split(/\s+/)
          .map((term) => term.replace(/[^\w\-]/g, ""))
          .filter((term) => term.length > 0);
        const hasSearch = rawTerms.length > 0;
        const sort = url.searchParams.get("sort") || (hasSearch ? "relevance" : "newest");

        const sortClauses = {
          newest: "v.date_pub DESC",
          views: "v.vues DESC",
          engagement: "CASE WHEN c.subscriber_count > 0 THEN CAST(v.vues AS REAL) / c.subscriber_count ELSE 0 END DESC",
          score: "c.llm_score DESC NULLS LAST",
          relevance: hasSearch ? "rank ASC" : "v.date_pub DESC",
        };
        if (!sortClauses[sort]) {
          return json({ error: "Invalid sort" }, 400);
        }

        // Build query dynamically
        const joins = [];
        const conditions = ["c.status = 'validated'", "v.duration > 60"];
        const params = [];

        if (hasSearch) {
          joins.push("JOIN videos_fts ON v.id = videos_fts.rowid");
          const ftsQuery = rawTerms.map((t) => `"${t}"*`).join(" AND ");
          conditions.push("videos_fts MATCH ?");
          params.push(ftsQuery);
        }

        if (topic === "0") {
          conditions.push("NOT EXISTS (SELECT 1 FROM channel_topics ct WHERE ct.channel_id = v.channel_id)");
        } else if (topic) {
          const topicId = Number(topic);
          if (!Number.isSafeInteger(topicId) || topicId < 1) {
            return json({ error: "topic must be a positive integer or 0" }, 400);
          }
          joins.push("JOIN channel_topics ct ON v.channel_id = ct.channel_id");
          conditions.push("ct.topic_id = ?");
          params.push(topicId);
        } else if (channel) {
          conditions.push("v.channel_id = ?");
          params.push(channel);
        }

        params.push(limit, offset);

        const rankSelect = hasSearch ? ", bm25(videos_fts) as rank" : "";
        const sql = `
          SELECT DISTINCT v.*, c.nom as channel_nom${rankSelect}
          FROM videos v
          JOIN channels c ON v.channel_id = c.channel_id
          ${joins.join("\n")}
          WHERE ${conditions.join(" AND ")}
          ORDER BY ${sortClauses[sort]}
          LIMIT ? OFFSET ?
        `;

        const videos = db.query(sql).all(...params);
        return json(videos);
      },
    },

    "/api/channels/resolve": {
      POST: async (req) => {
        const body = await readBody(req);
        if (typeof body.input !== "string" || !body.input.trim() || body.input.length > 2000) {
          return json({ error: "input must be a non-empty string" }, 400);
        }

        const result = await resolveChannel(body.input);
        if (!result) return json({ error: "Channel not found" }, 404);
        return json(result);
      },
    },

    "/api/channels": {
      GET: (req) => {
        const url = new URL(req.url);
        const status = url.searchParams.get("status");
        const include = url.searchParams.get("include");
        const q = url.searchParams.get("q")?.trim() || "";
        const sort = url.searchParams.get("sort") || "date_desc";
        let channels;

        const sortMap = {
          date_desc: "c.date_ajout DESC",
          date_asc: "c.date_ajout ASC",
          name: "c.nom COLLATE NOCASE ASC",
          score: "c.llm_score DESC NULLS LAST",
          subs: "c.subscriber_count DESC",
        };
        const orderClause = sortMap[sort] || "c.date_ajout DESC";

        const hasChannelFts = !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels_fts'`).get();

        if (q) {
          // Safe term extraction: keep letters/digits/accents/hyphens, drop FTS syntax.
          const terms = q
            .replace(/['"]/g, "")
            .split(/\s+/)
            .map((t) => t.replace(/[^\w\u00C0-\u00FF-]/g, ""))
            .filter((t) => t.length > 0);
          if (terms.length > 0 && hasChannelFts) {
            // Fast candidate pre-filter through the FTS5 trigram index (substring match).
            // The trigram tokenizer needs >= 3 chars per term; shorter terms fall back to LIKE.
            const ftsTerms = terms.filter((t) => t.length >= 3);
            const likeTerms = terms.filter((t) => t.length < 3);
            const conditions = [];
            const params = [];
            if (ftsTerms.length) {
              conditions.push("channels_fts MATCH ?");
              params.push(ftsTerms.map((t) => `\"${t}\"`).join(" AND "));
            }
            // Escape LIKE wildcards (% _) in the short-term fallback.
            const esc = (t) => t.replace(/[\\%_]/g, (m) => `\\${m}`);
            for (const t of likeTerms) {
              conditions.push("c.nom LIKE ? ESCAPE '\\'");
              params.push(`%${esc(t)}%`);
            }
            if (status) {
              conditions.push("c.status = ?");
              params.push(status);
            }
            const sql = `
              SELECT DISTINCT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.channel_id) as video_count
              FROM channels_fts
              JOIN channels c ON c.rowid = channels_fts.rowid
              WHERE ${conditions.join(" AND ")}
              ORDER BY bm25(channels_fts, 10.0)
              LIMIT 200
            `;
            try {
              channels = db.query(sql).all(...params);
            } catch (err) {
              // Self-heal: a stale/corrupt FTS index (SQLITE_CORRUPT_VTAB) would
              // otherwise 500 every search. Rebuild it once and retry.
              if (err.code === "SQLITE_CORRUPT_VTAB") {
                console.error("[Server] channels_fts corrupt — rebuilding index:", err.message);
                try {
                  rebuildChannelsFts();
                  channels = db.query(sql).all(...params);
                } catch (rebuildErr) {
                  console.error("[Server] channels_fts rebuild failed:", rebuildErr.message);
                  throw rebuildErr;
                }
              } else {
                throw err;
              }
            }
          } else if (terms.length > 0) {
            // No FTS index (or query too short for trigram): plain LIKE fallback over the whole table.
            const esc = (t) => t.replace(/[\\%_]/g, (m) => `\\${m}`);
            const like = `%${esc(q)}%`;
            channels = status
              ? db.query(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.channel_id) as video_count FROM channels c WHERE c.status = ? AND c.nom LIKE ? ESCAPE '\\' ORDER BY c.date_ajout DESC LIMIT 200`).all(status, like)
              : db.query(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.channel_id) as video_count FROM channels c WHERE c.nom LIKE ? ESCAPE '\\' ORDER BY c.date_ajout DESC LIMIT 200`).all(like);
          } else {
            channels = [];
          }
        } else if (status === "rejected") {
          channels = stmts.getChannelsByStatus.all(status);
          if (channels.length === 0) {
            channels = stmts.getRejectedFromFeedback.all();
          }
        } else if (status) {
          channels = stmts.getChannelsByStatus.all(status);
        } else {
          channels = stmts.getAllChannels.all();
        }

        // Apply scored/unscored filter (works on top of any status)
        if (status === "scored") {
          channels = channels.filter(c => c.llm_score != null);
        } else if (status === "unscored") {
          channels = channels.filter(c => c.llm_score == null);
        }

        // Apply sort (skip for FTS search which already orders by relevance)
        if (!q && sort !== "date_desc") {
          const [col, dir] = orderClause.split(" ");
          const desc = dir === "DESC";
          channels.sort((a, b) => {
            let va = a[col.startsWith("c.") ? col.slice(2) : col];
            let vb = b[col.startsWith("c.") ? col.slice(2) : col];
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === "string") {
              va = va.toLowerCase();
              vb = String(vb || "").toLowerCase();
              return desc ? vb.localeCompare(va) : va.localeCompare(vb);
            }
            return desc ? vb - va : va - vb;
          });
        }

        if (include === "topics,preview") {
          channels = channels.map((ch) => {
            const topics = stmts.getChannelTopics.all(ch.channel_id);
            const preview_videos = ch.status === "pending"
              ? db.query(
                  `SELECT titre, thumbnail, vues, url FROM videos WHERE channel_id = ? ORDER BY date_pub DESC LIMIT 3`
                ).all(ch.channel_id)
              : [];
            return { ...ch, topics, preview_videos };
          });
        }

        return json(channels);
      },
      POST: async (req) => {
        const body = await readBody(req);
        const { nom, channel_id, input } = body;

        let resolvedNom = nom;
        let resolvedId = channel_id;

        if (input && !channel_id) {
          const resolved = await resolveChannel(input);
          if (!resolved) {
            return json({ error: "Could not resolve channel from input" }, 400);
          }
          resolvedId = resolved.channelId;
          resolvedNom = resolved.nom;
        }

        if (!resolvedNom || !resolvedId) {
          return json({ error: "nom and channel_id required (or input)" }, 400);
        }
        if (!isYoutubeChannelId(resolvedId)) {
          return json({ error: "channel_id must be a valid YouTube channel ID" }, 400);
        }
        resolvedNom = String(resolvedNom).trim().slice(0, 200);
        if (!resolvedNom) return json({ error: "nom required" }, 400);

        const existing = stmts.getChannelByYoutubeId.get(resolvedId);
        if (existing) {
          return json({ error: "Channel already exists", channel: existing }, 409);
        }

        // Scrape stats for FREE (zero API cost)
        const info = await scrapeChannelInfo(resolvedId);

        stmts.insertChannel.run({
          $nom: resolvedNom,
          $channel_id: resolvedId,
          $subscriber_count: info.subscriberCount,
          $last_video_date: null,
          $thumbnail: info.thumbnail || "",
          $description: info.description || "",
        });

        // Auto-ingest recent videos from RSS feed (free)
        ingestChannel(resolvedId).catch((e) => console.error("[Ingest] Failed:", e.message));

        const result = stmts.getChannelByYoutubeId.get(resolvedId);
        return json(result, 201);
      },
    },

    "/api/channels/:id/validate": {
      POST: (req) => {
        const id = parsePositiveId(req.params.id);
        if (!id) return json({ error: "Invalid channel id" }, 400);
        const ch = db.query(`SELECT channel_id, nom FROM channels WHERE id = ?`).get(id);
        if (!ch) return json({ error: "Channel not found" }, 404);
        const validateTx = db.transaction(() => {
          stmts.insertFeedback.run({
            $channel_id: ch.channel_id,
            $channel_nom: ch.nom,
            $decision: "validated",
            $raison: "",
          });
          stmts.updateChannelStatus.run({ $status: "validated", $id: id });
        });
        validateTx();
        // Fire-and-forget: deep crawl videos in the background
        ingestChannel(ch.channel_id).catch(err => console.error(`[Validate] ingest failed for ${ch.nom}:`, err.message));
        return json({ ok: true });
      },
    },

    "/api/channels/:id/reject": {
      POST: async (req) => {
        const id = parsePositiveId(req.params.id);
        if (!id) return json({ error: "Invalid channel id" }, 400);
        const body = await readBody(req);
        const rejectionReason = typeof body.raison === "string" ? body.raison.trim().slice(0, 1000) : "";

        const ch = db.query(`SELECT channel_id, nom FROM channels WHERE id = ?`).get(id);
        if (!ch) return json({ error: "Channel not found" }, 404);

        const rejectTx = db.transaction(() => {
          stmts.insertFeedback.run({
            $channel_id: ch.channel_id,
            $channel_nom: ch.nom,
            $decision: "rejected",
            $raison: rejectionReason,
          });
          stmts.deleteChannelVideos.run(ch.channel_id);
          stmts.updateChannelRejection.run({ $raison: rejectionReason, $id: id });
        });
        rejectTx();

        return json({ ok: true });
      },
    },

    "/api/channels/:id/score": {
      POST: (req) => runScoringJob(async () => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id < 1) return json({ error: "Invalid channel id" }, 400);
        const ch = db.query(`SELECT channel_id FROM channels WHERE id = ?`).get(id);
        if (!ch) return json({ error: "Channel not found" }, 404);

        const result = await scoreChannel(ch.channel_id);
        if (!result?.ok) {
          return json({ error: result?.reason || "Scoring failed" });
        }
        return json(result);
      }),
    },

    "/api/ingest/:channelId": {
      POST: async (req) => {
        const channelId = req.params.channelId;
        if (!isYoutubeChannelId(channelId)) return json({ error: "Invalid YouTube channel id" }, 400);
        const result = await ingestChannel(channelId);
        return json(result);
      },
    },

    "/api/ingest/:channelId/deep": {
      POST: async (req) => {
        const channelId = req.params.channelId;
        if (!isYoutubeChannelId(channelId)) return json({ error: "Invalid YouTube channel id" }, 400);
        const result = await deepIngestChannel(channelId);
        return json(result);
      },
    },

    "/api/refresh": {
      POST: async () => {
        if (isRefreshingRSS) {
          return json({ ok: true, message: "Refresh already in progress" });
        }
        isRefreshingRSS = true;
        refreshProgress.total = 0;
        refreshProgress.completed = 0;
        refreshProgress.errors = 0;
        refreshProgress.current = "";
        refreshProgress.status = "running";
        refreshAllChannels((p) => {
          refreshProgress.total = p.total;
          if (p.status === "done") refreshProgress.completed++;
          else if (p.status === "error") refreshProgress.errors++;
          refreshProgress.current = p.nom;
        })
          .then((results) => {
            refreshProgress.status = "done";
            markRSSLastRun();
            console.log(`[Refresh] Completed: ${results.length} channels`);
          })
          .catch((e) => {
            refreshProgress.status = "error";
            console.error("[Refresh] Error:", e.message);
          })
          .finally(() => { isRefreshingRSS = false; });
        return json({ ok: true, message: "Refresh started in background" });
      },
    },

    "/api/refresh/status": {
      GET: () => json(refreshProgress),
    },

    "/api/refresh-videos": {
      POST: async () => {
        if (isRefreshingVideos) {
          return json({ ok: true, message: "Refresh already in progress" });
        }
        isRefreshingVideos = true;
        refreshVideosProgress.total = 0;
        refreshVideosProgress.completed = 0;
        refreshVideosProgress.errors = 0;
        refreshVideosProgress.current = "";
        refreshVideosProgress.status = "running";
        refreshAllVideos((p) => {
          refreshVideosProgress.total = p.total;
          if (p.status === "done") refreshVideosProgress.completed++;
          else if (p.status === "error") refreshVideosProgress.errors++;
          refreshVideosProgress.current = p.nom;
        })
          .then((results) => {
            refreshVideosProgress.status = "done";
            console.log(`[RefreshVideos] Completed: ${results.length} channels`);
          })
          .catch((e) => {
            refreshVideosProgress.status = "error";
            console.error("[RefreshVideos] Error:", e.message);
          })
          .finally(() => { isRefreshingVideos = false; });
        return json({ ok: true, message: "Full video refresh started in background" });
      },
    },

    "/api/refresh-videos/status": {
      GET: () => json(refreshVideosProgress),
    },

    "/api/refresh-pending-videos": {
      POST: async () => {
        if (isRefreshingPendingVideos) {
          return json({ ok: true, message: "Refresh already in progress" });
        }
        isRefreshingPendingVideos = true;
        pendingVideosProgress.total = 0;
        pendingVideosProgress.completed = 0;
        pendingVideosProgress.errors = 0;
        pendingVideosProgress.current = "";
        pendingVideosProgress.status = "running";
        refreshPendingWithoutVideos((p) => {
          pendingVideosProgress.total = p.total;
          if (p.status === "done") pendingVideosProgress.completed++;
          else if (p.status === "error") pendingVideosProgress.errors++;
          pendingVideosProgress.current = p.nom;
        })
          .then((results) => {
            pendingVideosProgress.status = "done";
            console.log(`[RefreshPendingVideos] Completed: ${results.length} channels`);
          })
          .catch((e) => {
            pendingVideosProgress.status = "error";
            console.error("[RefreshPendingVideos] Error:", e.message);
          })
          .finally(() => { isRefreshingPendingVideos = false; });
        return json({ ok: true, message: "Pending video crawl started in background" });
      },
    },

    "/api/refresh-pending-videos/status": {
      GET: () => json(pendingVideosProgress),
    },

    "/api/channels/refresh-stats": {
      POST: async () => {
        if (isRefreshingStats) {
          return json({ ok: true, message: "Refresh already in progress" });
        }
        isRefreshingStats = true;
        (async () => {
          try {
            const channels = stmts.getAllChannels.all();
            console.log(`[RefreshStats] Updating ${channels.length} channels...`);
            let updated = 0;
            refreshStatsProgress.total = channels.length;
            refreshStatsProgress.completed = 0;
            refreshStatsProgress.current = "";
            refreshStatsProgress.status = "running";
            await runWithLimit(channels, async (ch) => {
              try {
                const info = await scrapeChannelInfo(ch.channel_id);
                if (info.subscriberCount || info.thumbnail || info.name) {
                  stmts.refreshChannelInfo.run({
                    $nom: info.name || ch.nom,
                    $subscriber_count: info.subscriberCount || ch.subscriber_count,
                    $thumbnail: info.thumbnail || ch.thumbnail,
                    $description: info.description || ch.description || "",
                    $channel_id: ch.channel_id,
                  });
                  updated++;
                }
              } catch {}
              refreshStatsProgress.completed++;
              refreshStatsProgress.current = ch.nom;
            }, 3, 300);
            refreshStatsProgress.status = "done";
            console.log(`[RefreshStats] Updated ${updated}/${channels.length} channels`);
          } catch (e) {
            refreshStatsProgress.status = "error";
            console.error("[RefreshStats] Error:", e.message);
          } finally {
            isRefreshingStats = false;
          }
        })();
        return json({ ok: true, message: "Channel stats refresh started" });
      },
    },

    "/api/refresh-stats/status": {
      GET: () => json(refreshStatsProgress),
    },

    "/api/topics": {
      GET: () => json(stmts.getAllTopics.all()),
      POST: async (req) => {
        const body = await readBody(req);
        if (typeof body.nom !== "string" || !body.nom.trim()) return json({ error: "nom required" }, 400);
        const info = stmts.insertTopic.run({
          $nom: body.nom.trim().slice(0, 200),
          $description: typeof body.description === "string" ? body.description.trim().slice(0, 1000) : "",
        });
        return json({ ok: true, id: info.lastInsertRowid }, 201);
      },
      PATCH: async (req) => {
        const body = await readBody(req);
        if (!Array.isArray(body.order)) return json({ error: "order must be an array" }, 400);
        for (const item of body.order) {
          if (!Number.isSafeInteger(item.id) || item.id < 1 || !Number.isSafeInteger(item.display_order)) continue;
          stmts.updateTopicOrder.run(item.display_order, item.id);
        }
        return json({ ok: true });
      },
      DELETE: async (req) => {
        const url = new URL(req.url);
        const id = parsePositiveId(url.searchParams.get("id"));
        if (!id) return json({ error: "id must be a positive integer" }, 400);
        stmts.deleteTopic.run(id);
        return json({ ok: true });
      },
    },

    "/api/discover": {
      POST: async (req) => {
        const body = await readBody(req);
        const topicQuery = typeof body.topic === "string" ? body.topic.trim().slice(0, 300) : "";
        if (!topicQuery) return json({ error: "topic required" }, 400);

        const results = await discoverFromTopic(topicQuery);

        // Auto-ingest videos for newly discovered channels (free RSS)
        if (results.channels.length > 0) {
          Promise.all(results.channels.map((ch) =>
            ingestChannel(ch.channelId).catch(() => {})
          )).catch(() => {});
        }

        return json({ ok: true, topic: topicQuery, found: results.channels.length, channels: results.channels, method: results.method });
      },
    },

    "/api/score-all": {
      POST: () => {
        const jobId = startScoringJob("pending", scoreAllPending);
        if (!jobId) return json({ error: "A scoring job is already in progress" }, 409);
        return json({ ok: true, status: "running", jobId }, 202);
      },
    },

    "/api/score-unscored": {
      POST: () => {
        const jobId = startScoringJob("unscored", scoreAllUnscored);
        if (!jobId) return json({ error: "A scoring job is already in progress" }, 409);
        return json({ ok: true, status: "running", jobId }, 202);
      },
    },

    "/api/rescore-all": {
      POST: () => {
        const jobId = startScoringJob("rescore", rescoreAllChannels);
        if (!jobId) return json({ error: "A scoring job is already in progress" }, 409);
        return json({ ok: true, status: "running", jobId }, 202);
      },
    },

    "/api/watched": {
      GET: () => {
        const rows = stmts.getAllWatchedVideos.all();
        return json(rows.map(r => r.url));
      },
      POST: async (req) => {
        const body = await readBody(req);
        if (typeof body.url === "string" && body.url.length <= 2000) {
          stmts.insertWatchedVideo.run(body.url.trim());
        }
        return json({ ok: true });
      },
      DELETE: async (req) => {
        const body = await readBody(req);
        if (typeof body.url === "string" && body.url.length <= 2000) {
          stmts.deleteWatchedVideo.run(body.url.trim());
        }
        return json({ ok: true });
      },
    },

    "/api/export": {
      GET: () => {
        const settings = getAllSettings();
        const channels = stmts.getAllChannels.all();
        const videos = stmts.getAllVideos.all();
        const topics = stmts.getAllTopics.all();
        const channelTopics = stmts.getAllChannelTopics.all();
        const feedback = stmts.getAllFeedback.all();
        const watched = stmts.getAllWatchedVideos.all().map((row) => row.url);
        // Secrets must never leave the local process.
        delete settings.openrouter_key;
        return json({
          version: 2,
          exportedAt: new Date().toISOString(),
          settings,
          channels,
          videos,
          topics,
          channelTopics,
          feedback,
          watched,
        });
      },
    },

    "/api/import": {
      POST: async (req) => {
        const body = await readBody(req);
        if (!body || !Array.isArray(body.channels) || !body.settings || !Array.isArray(body.topics)) {
          return json({ error: "Invalid backup format" }, 400);
        }
        if (body.channels.length > 100_000 || body.topics.length > 10_000 || (body.videos?.length || 0) > 1_000_000) {
          return json({ error: "Backup contains too many records" }, 413);
        }

        const imported = {
          channels: 0,
          videos: 0,
          topics: 0,
          channelTopics: 0,
          feedback: 0,
          watched: 0,
          settings: 0,
        };

        try {
          db.transaction(() => {
            // Restore settings (skip secrets and unknown keys).
            for (const [key, value] of Object.entries(body.settings)) {
              if (SECRET_SETTINGS.has(key) || !SETTINGS_KEYS.has(key) || typeof value !== "string") continue;
              setSetting(key, value.trim());
              imported.settings++;
            }

            // Map exported topic IDs to local IDs so imports work across databases.
            const localTopics = new Map(
              stmts.getAllTopics.all().map((topic) => [topic.nom.trim().toLowerCase(), topic.id])
            );
            const topicIds = new Map();
            for (const topic of body.topics) {
              const name = typeof topic?.nom === "string" ? topic.nom.trim().slice(0, 200) : "";
              if (!name) continue;
              const key = name.toLowerCase();
              let localId = localTopics.get(key);
              if (!localId) {
                const result = stmts.insertTopic.run({
                  $nom: name,
                  $description: typeof topic.description === "string" ? topic.description.slice(0, 1000) : "",
                });
                localId = Number(result.lastInsertRowid);
                localTopics.set(key, localId);
                imported.topics++;
              }
              if (Number.isSafeInteger(topic.id)) topicIds.set(topic.id, localId);
              if (Number.isSafeInteger(topic.display_order)) stmts.updateTopicOrder.run(topic.display_order, localId);
            }

            // Upsert channels first so videos, feedback and topic links have a parent.
            const channelIds = new Map();
            for (const channel of body.channels) {
              if (!isYoutubeChannelId(channel?.channel_id)) continue;
              const status = ["pending", "validated", "rejected"].includes(channel.status)
                ? channel.status
                : "pending";
              stmts.upsertImportedChannel.run({
                $nom: String(channel.nom || channel.channel_id).slice(0, 200),
                $channel_id: channel.channel_id,
                $status: status,
                $date_ajout: channel.date_ajout || null,
                $raison_rejet: typeof channel.raison_rejet === "string" ? channel.raison_rejet.slice(0, 1000) : "",
                $subscriber_count: Number.isFinite(channel.subscriber_count) ? channel.subscriber_count : 0,
                $last_video_date: channel.last_video_date || null,
                $llm_summary: typeof channel.llm_summary === "string" ? channel.llm_summary.slice(0, 5000) : "",
                $llm_score: Number.isFinite(channel.llm_score) ? Math.min(100, Math.max(0, channel.llm_score)) : null,
                $thumbnail: typeof channel.thumbnail === "string" ? channel.thumbnail.slice(0, 2000) : "",
                $description: typeof channel.description === "string" ? channel.description.slice(0, 5000) : "",
                $last_refresh: channel.last_refresh || null,
              });
              channelIds.set(channel.channel_id, channel.channel_id);
              imported.channels++;
            }

            for (const video of Array.isArray(body.videos) ? body.videos : []) {
              if (!channelIds.has(video?.channel_id) || typeof video?.url !== "string" || !video.url) continue;
              stmts.upsertImportedVideo.run({
                $channel_id: video.channel_id,
                $titre: String(video.titre || "Sans titre").slice(0, 500),
                $description: typeof video.description === "string" ? video.description.slice(0, 10000) : "",
                $url: video.url.slice(0, 2000),
                $thumbnail: typeof video.thumbnail === "string" ? video.thumbnail.slice(0, 2000) : "",
                $date_pub: video.date_pub || null,
                $vues: Number.isFinite(video.vues) ? Math.max(0, video.vues) : 0,
                $duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
              });
              imported.videos++;
            }

            for (const link of Array.isArray(body.channelTopics) ? body.channelTopics : []) {
              const topicId = topicIds.get(link?.topic_id) || link?.topic_id;
              if (!channelIds.has(link?.channel_id) || !Number.isSafeInteger(topicId)) continue;
              stmts.assignTopic.run(link.channel_id, topicId);
              imported.channelTopics++;
            }

            for (const event of Array.isArray(body.feedback) ? body.feedback : []) {
              if (!channelIds.has(event?.channel_id) || !["validated", "rejected"].includes(event?.decision)) continue;
              stmts.insertFeedbackExport.run({
                $channel_id: event.channel_id,
                $channel_nom: typeof event.channel_nom === "string" ? event.channel_nom.slice(0, 200) : "",
                $decision: event.decision,
                $raison: typeof event.raison === "string" ? event.raison.slice(0, 1000) : "",
                $date_decision: event.date_decision || null,
              });
              imported.feedback++;
            }

            for (const url of Array.isArray(body.watched) ? body.watched : []) {
              if (typeof url !== "string" || !url || url.length > 2000) continue;
              stmts.insertWatchedVideo.run(url);
              imported.watched++;
            }
          })();
        } catch (error) {
          console.error("[Import] Transaction rolled back:", error.message);
          return json({ error: "Import failed: " + error.message }, 400);
        }
        return json({ ok: true, imported });
      },
    },

    "/api/rss-info": {
      GET: () => json(getRSSInfo()),
    },

    "/api/llm-status": {
      GET: async () => {
        const status = await checkLLMHealth();
        return json({ ...status });
      },
    },

    "/api/feedback": {
      GET: (req) => {
        const url = new URL(req.url);
        const requestedLimit = Number(url.searchParams.get("limit") || "20");
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
          return json({ error: "limit must be >= 1" }, 400);
        }
        const feedback = stmts.getRecentRejections.all(Math.min(requestedLimit, 100));
        return json(feedback);
      },
    },

    "/api/settings": {
      GET: () => json(getPublicSettings()),
      POST: async (req) => {
        const body = await readBody(req);
        const provider = typeof body.llm_provider === "string" ? body.llm_provider.trim() : null;
        if (provider && !["ollama", "lmstudio", "openrouter"].includes(provider)) {
          return json({ error: "Unknown LLM provider" }, 400);
        }

        const clearSecrets = Array.isArray(body.clear_secrets) ? body.clear_secrets : [];
        for (const [key, value] of Object.entries(body)) {
          if (!SETTINGS_KEYS.has(key) || key === "clear_secrets" || typeof value !== "string") continue;
          const trimmed = value.trim();
          // Empty secret fields preserve the stored value unless explicitly cleared.
          if (SECRET_SETTINGS.has(key) && !trimmed && !clearSecrets.includes(key)) continue;
          setSetting(key, trimmed);
        }
        for (const key of clearSecrets) {
          if (SECRET_SETTINGS.has(key)) setSetting(key, "");
        }
        return json({ ok: true, settings: getPublicSettings() });
      },
    },
  },

  // ═══════════════════════════════════════════
  //  FETCH HANDLER (non-standard routes + static files)
  // ═══════════════════════════════════════════
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (!checkRateLimit(req)) {
      return json({ error: "Rate limit exceeded" }, 429);
    }

    try {
      // POST /api/discover/related — start a background job. Results are exposed incrementally below.
      if (method === "POST" && pathname === "/api/discover/related") {
        if (isRelatedRunning) {
          return json({ error: "Related discovery already in progress" }, 409);
        }

        const body = await readBody(req);
        const passes = Math.max(1, Math.min(10, Number(body?.passes) || 1));
        const validStatuses = ['pending', 'validated', 'rejected'];
        const statuses = Array.isArray(body?.statuses) && body.statuses.length > 0
          ? [...new Set(body.statuses.filter(s => validStatuses.includes(s)))]
          : ['validated'];
        if (statuses.length === 0) {
          return json({ error: "At least one valid status is required" }, 400);
        }

        isRelatedRunning = true;
        relatedJobId = createJobId();
        relatedAbortController = new AbortController();
        relatedPaused = false;
        resetProgressTracker(relatedProgress, {
          found: 0,
          results: [],
          error: "",
        });

        const pauseRef = { get paused() { return relatedPaused; } };

        discoverRelatedFromValidated(
          (completed, total, current, status) => {
            relatedProgress.total = total;
            // Multiple validated channels are processed concurrently; never let a late
            // "started" callback move the visible counter backwards.
            relatedProgress.completed = Math.max(relatedProgress.completed, completed);
            relatedProgress.current = current || "";
            if (status === "done") relatedProgress.current = current || "";
          },
          (result) => {
            // Do not accept late callbacks after cancellation. The worker pool
            // waits for all workers, but this guard also protects future adapters.
            if (relatedAbortController?.signal.aborted) return;
            relatedProgress.results.push(result);
            relatedProgress.found = relatedProgress.results.length;
            // Auto-ingest videos (free) so newly found channels have videos right
            // away, matching the Discover page workflow.
            ingestChannel(result.channelId).catch((err) => console.error("[Related] ingest failed:", err.message));
          },
          { passes, statuses, signal: relatedAbortController.signal, pauseRef }
        )
          .then(() => {
            relatedProgress.status = "done";
            relatedProgress.completed = relatedProgress.total;
          })
          .catch((err) => {
            if (err.name === 'AbortError' || err.message === 'Aborted') {
              relatedProgress.status = "cancelled";
              console.log("[Related] Discovery cancelled by user");
            } else {
              relatedProgress.status = "error";
              relatedProgress.error = err.message;
              console.error("[Related] Discovery error:", err.message);
            }
          })
          .finally(() => {
            isRelatedRunning = false;
            relatedAbortController = null;
            relatedPaused = false;
          });

        return json({ ok: true, status: "running", jobId: relatedJobId }, 202);
      }

      // GET /api/discover/related/status?job=...&since=N — poll one job and only receive new results.
      if (method === "GET" && pathname === "/api/discover/related/status") {
        const requestedJobId = url.searchParams.get("job");
        const sinceValue = Number(url.searchParams.get("since") || "0");
        if (!requestedJobId) return json({ error: "job is required" }, 400);
        if (!Number.isInteger(sinceValue) || sinceValue < 0) {
          return json({ error: "since must be a non-negative integer" }, 400);
        }
        if (requestedJobId !== relatedJobId) {
          return json({ error: "Related discovery job is no longer available", jobId: relatedJobId }, 409);
        }
        return json({
          jobId: relatedJobId,
          total: relatedProgress.total,
          completed: relatedProgress.completed,
          found: relatedProgress.found,
          current: relatedProgress.current,
          status: relatedProgress.status,
          paused: relatedPaused,
          error: relatedProgress.error,
          results: relatedProgress.results.slice(sinceValue),
          next: relatedProgress.results.length,
        });
      }

      // POST /api/discover/related/cancel — abort the running job
      if (method === "POST" && pathname === "/api/discover/related/cancel") {
        if (!isRelatedRunning) {
          return json({ error: "No related discovery in progress" }, 409);
        }
        relatedAbortController?.abort();
        return json({ ok: true, status: "cancelling" });
      }

      // POST /api/discover/related/pause — toggle pause state
      if (method === "POST" && pathname === "/api/discover/related/pause") {
        if (!isRelatedRunning) {
          return json({ error: "No related discovery in progress" }, 409);
        }
        relatedPaused = !relatedPaused;
        relatedProgress.status = relatedPaused ? "paused" : "running";
        return json({ ok: true, paused: relatedPaused, status: relatedProgress.status });
      }

      // --- API routes handled in fetch (bypass Bun router quirks) ---

      // GET /api/score-status?job=... — live progress for background LLM scoring.
      if (method === "GET" && pathname === "/api/score-status") {
        const requestedJobId = url.searchParams.get("job");
        if (!requestedJobId) return json({ error: "job is required" }, 400);
        if (requestedJobId !== scoringJobId) {
          return json({ error: "Scoring job is no longer available", jobId: scoringJobId }, 409);
        }
        return json({ ...scoringProgress });
      }



      // POST /api/channels/resolve-video
      if (method === "POST" && pathname === "/api/channels/resolve-video") {
        const body = await readBody(req);
        if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 2000) {
          return json({ error: "url must be a non-empty string" }, 400);
        }
        const result = await resolveFromVideoUrl(body.url);
        if (!result) return json({ error: "Could not resolve channel from video URL" }, 404);
        return json(result);
      }

      // POST /api/channels/import
      if (method === "POST" && pathname === "/api/channels/import") {
        const body = await readBody(req);
        if (!body.text) return json({ error: "text required" }, 400);
        const { channelIds, handles } = extractChannelIdsFromText(body.text);
        const results = { added: 0, skipped: 0, errors: [], channels: [] };

        // Resolve handles to channel IDs
        for (const handle of handles) {
          try {
            const resolved = await resolveChannel(`@${handle}`);
            if (resolved?.channelId) channelIds.push(resolved.channelId);
          } catch (e) {
            results.errors.push(`Failed to resolve @${handle}: ${e.message}`);
          }
        }

        // Add each channel
        const blacklisted = new Set(stmts.getBlacklistedChannelIds.all().map((r) => r.channel_id));
        for (const channelId of new Set(channelIds)) {
          const existing = stmts.getChannelByYoutubeId.get(channelId);
          if (existing) { results.skipped++; continue; }
          if (blacklisted.has(channelId)) { results.skipped++; continue; }

          try {
            const info = await scrapeChannelInfo(channelId);
            stmts.insertChannel.run({
              $nom: info.name || channelId,
              $channel_id: channelId,
              $subscriber_count: info.subscriberCount,
              $last_video_date: null,
              $thumbnail: info.thumbnail || "",
              $description: info.description || "",
            });
            results.added++;
            const ch = stmts.getChannelByYoutubeId.get(channelId);
            results.channels.push(ch);
            // Auto-ingest in background
            ingestChannel(channelId).catch(() => {});
          } catch (e) {
            results.errors.push(`Failed to add ${channelId}: ${e.message}`);
          }
          await new Promise((r) => setTimeout(r, 300));
        }

        return json(results);
      }

      // GET /api/dashboard
      if (method === "GET" && pathname === "/api/dashboard") {
        const stats = stmts.getStats.get();
        const recentVideos = db.query(`
          SELECT v.*, c.nom as channel_nom, c.llm_score
          FROM videos v
          JOIN channels c ON v.channel_id = c.channel_id
          WHERE c.status = 'validated' AND v.duration > 60
          ORDER BY v.date_pub DESC LIMIT 12
        `).all();
        const pendingChannels = db.query(`
          SELECT * FROM channels WHERE status = 'pending'
          ORDER BY llm_score DESC NULLS LAST LIMIT 5
        `).all();
        const topChannels = db.query(`
          SELECT c.*, COUNT(v.id) as video_count
          FROM channels c
          LEFT JOIN videos v ON c.channel_id = v.channel_id
          WHERE c.status = 'validated'
          GROUP BY c.id
          ORDER BY c.llm_score DESC NULLS LAST, video_count DESC
          LIMIT 6
        `).all();
        return json({ stats, recentVideos, pendingChannels, topChannels });
      }

      // /api/channels/:id/topics (GET/POST/DELETE)
      const topicsMatch = pathname.match(/^\/api\/channels\/(\d+)\/topics$/);
      if (topicsMatch) {
        const chanId = parsePositiveId(topicsMatch[1]);
        if (!chanId) return json({ error: "Invalid channel id" }, 400);
        const ch = db.query(`SELECT channel_id FROM channels WHERE id = ?`).get(chanId);
        if (!ch) return json({ error: "Channel not found" }, 404);

        if (method === "GET") {
          return json(stmts.getChannelTopics.all(ch.channel_id));
        }
        if (method === "POST") {
          const body = await readBody(req);
          const topicId = parsePositiveId(body.topic_id);
          if (!topicId) return json({ error: "topic_id must be a positive integer" }, 400);
          const topic = db.query(`SELECT id FROM topics WHERE id = ?`).get(topicId);
          if (!topic) return json({ error: "Topic not found" }, 404);
          stmts.assignTopic.run(ch.channel_id, topicId);
          return json({ ok: true });
        }
        if (method === "DELETE") {
          const topicId = parsePositiveId(url.searchParams.get("topic_id"));
          if (!topicId) return json({ error: "topic_id must be a positive integer" }, 400);
          stmts.removeTopic.run(ch.channel_id, topicId);
          return json({ ok: true });
        }
        return json({ error: "Method not allowed" }, 405);
      }

      // GET /api/channels/:id/related
      const relatedMatch = pathname.match(/^\/api\/channels\/(\d+)\/related$/);
      if (relatedMatch && method === "GET") {
        const chanId = parsePositiveId(relatedMatch[1]);
        if (!chanId) return json({ error: "Invalid channel id" }, 400);
        const ch = db.query(`SELECT channel_id FROM channels WHERE id = ?`).get(chanId);
        if (!ch) return json({ error: "Channel not found" }, 404);
        const related = await scrapeRelatedChannels(ch.channel_id);
        return json(related);
      }

      // GET /api/channels/:id/preview (3 recent videos for validation preview)
      const previewMatch = pathname.match(/^\/api\/channels\/(\d+)\/preview$/);
      if (previewMatch && method === "GET") {
        const chanId = parsePositiveId(previewMatch[1]);
        if (!chanId) return json({ error: "Invalid channel id" }, 400);
        const ch = db.query(`SELECT channel_id FROM channels WHERE id = ?`).get(chanId);
        if (!ch) return json({ error: "Channel not found" }, 404);
        const videos = db.query(`
          SELECT titre, thumbnail, vues, url FROM videos
          WHERE channel_id = ? ORDER BY date_pub DESC LIMIT 3
        `).all(ch.channel_id);
        return json(videos);
      }

      // GET /api/channels/:id/detail (channel info + all videos)
      const detailMatch = pathname.match(/^\/api\/channels\/(\d+)\/detail$/);
      if (detailMatch && method === "GET") {
        const chanId = parsePositiveId(detailMatch[1]);
        if (!chanId) return json({ error: "Invalid channel id" }, 400);
        const ch = db.query(`SELECT * FROM channels WHERE id = ?`).get(chanId);
        if (!ch) return json({ error: "Channel not found" }, 404);
        const videos = db.query(`
          SELECT v.*, c.nom as channel_nom FROM videos v
          JOIN channels c ON v.channel_id = c.channel_id
          WHERE v.channel_id = ? ORDER BY v.date_pub DESC LIMIT 30
        `).all(ch.channel_id);
        const topics = stmts.getChannelTopics.all(ch.channel_id);
        return json({ channel: ch, videos, topics });
      }

    } catch (err) {
      console.error(`[Fetch] ${method} ${pathname}:`, err.message);
      return json({ error: err.message || "Internal server error" }, err.status || 500);
    }

    // --- Static files ---

    if (pathname === "/") {
      const file = Bun.file(join(PUBLIC_DIR, "index.html"));
      return new Response(file, {
        headers: { "Content-Type": "text/html" },
      });
    }

    const staticRes = serveStatic(pathname);
    if (staticRes) return staticRes;

    return new Response("Not Found", { status: 404 });
  },

  // ═══════════════════════════════════════════
  //  ERROR HANDLER
  // ═══════════════════════════════════════════
  error(error) {
    console.error("[Server]", error);
    return new Response(JSON.stringify({ error: error.message || "Internal server error" }), {
      status: error.status || 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  },
});

console.log(`\n  YouFind running at http://localhost:${server.port}\n`);

// ═══ STARTUP ═══
// Start cron scheduler for automated tasks
startCron();
