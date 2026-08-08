import { join, dirname, resolve, relative } from "path";
import { db, stmts, getSetting, setSetting, getAllSettings, rebuildChannelsFts } from "./db.js";
import { ingestChannel, refreshAllChannels, refreshAllVideos } from "./rss.js";
import { discoverFromTopic, getQuotaUsage, resolveChannel, scrapeChannelInfo, resolveFromVideoUrl, scrapeRelatedChannels, extractChannelIdsFromText, discoverRelatedFromValidated } from "./youtube-api.js";
import { scoreChannel, scoreAllPending, scoreAllUnscored, rescoreAllChannels, checkLLMHealth } from "./llm.js";
import { startCron, getRSSInfo, markRSSLastRun } from "./cron.js";

const PORT = parseInt(Bun.env.PORT || "3000");
const HOST = Bun.env.HOST || "127.0.0.1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SETTINGS_KEYS = new Set([
  "youtube_api_key", "llm_provider",
  "ollama_url", "ollama_model",
  "lmstudio_url", "lmstudio_model",
  "openrouter_key", "openrouter_model",
]);
const SECRET_SETTINGS = new Set(["youtube_api_key", "openrouter_key"]);

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
  try {
    return await req.json();
  } catch {
    return {};
  }
}

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

let isRefreshingRSS = false;
let isRefreshingVideos = false;
let isRefreshingStats = false;
let isScoring = false;
let scoringJobId = null;
const scoringProgress = {
  jobId: null,
  mode: "",
  total: 0,
  completed: 0,
  scored: 0,
  failed: 0,
  current: "",
  status: "idle",
  error: "",
};
let isRelatedRunning = false;
let relatedJobId = null;
const refreshProgress = { total: 0, completed: 0, errors: 0, current: "", status: "idle" };
const refreshVideosProgress = { total: 0, completed: 0, errors: 0, current: "", status: "idle" };
const relatedProgress = {
  total: 0,
  completed: 0,
  found: 0,
  current: "",
  status: "idle",
  results: [],
  error: "",
};

function createJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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
  scoringProgress.jobId = scoringJobId;
  scoringProgress.mode = mode;
  scoringProgress.total = 0;
  scoringProgress.completed = 0;
  scoringProgress.scored = 0;
  scoringProgress.failed = 0;
  scoringProgress.current = "";
  scoringProgress.status = "running";
  scoringProgress.error = "";

  Promise.resolve()
    .then(() => scorer((progress) => {
      scoringProgress.total = progress.total;
      scoringProgress.completed = progress.completed;
      scoringProgress.scored = progress.scored;
      scoringProgress.failed = progress.failed;
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
        if (!body.input) return json({ error: "input required" }, 400);

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
        let channels;

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
              SELECT DISTINCT c.*
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
              ? db.query(`SELECT * FROM channels WHERE status = ? AND nom LIKE ? ESCAPE '\\' ORDER BY date_ajout DESC LIMIT 200`).all(status, like)
              : db.query(`SELECT * FROM channels WHERE nom LIKE ? ESCAPE '\\' ORDER BY date_ajout DESC LIMIT 200`).all(like);
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
        return json({ ok: true });
      },
    },

    "/api/channels/:id/reject": {
      POST: async (req) => {
        const id = parsePositiveId(req.params.id);
        if (!id) return json({ error: "Invalid channel id" }, 400);
        const body = await readBody(req);

        const ch = db.query(`SELECT channel_id, nom FROM channels WHERE id = ?`).get(id);
        if (!ch) return json({ error: "Channel not found" }, 404);

        const rejectTx = db.transaction(() => {
          stmts.insertFeedback.run({
            $channel_id: ch.channel_id,
            $channel_nom: ch.nom,
            $decision: "rejected",
            $raison: body.raison || "",
          });
          stmts.deleteChannelVideos.run(ch.channel_id);
          stmts.updateChannelRejection.run({ $raison: body.raison || "", $id: id });
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
        return json(result || { error: "Scoring failed" });
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
            for (const ch of channels) {
              try {
                const info = await scrapeChannelInfo(ch.channel_id);
                if (info.subscriberCount || info.thumbnail || info.name) {
                  stmts.refreshChannelInfo.run({
                    $nom: info.name || ch.nom,
                    $subscriber_count: info.subscriberCount || ch.subscriber_count,
                    $thumbnail: info.thumbnail || ch.thumbnail,
                    $channel_id: ch.channel_id,
                  });
                  updated++;
                }
              } catch {}
              await new Promise((r) => setTimeout(r, 300));
            }
            console.log(`[RefreshStats] Updated ${updated}/${channels.length} channels`);
          } catch (e) {
            console.error("[RefreshStats] Error:", e.message);
          } finally {
            isRefreshingStats = false;
          }
        })();
        return json({ ok: true, message: "Channel stats refresh started" });
      },
    },

    "/api/topics": {
      GET: () => json(stmts.getAllTopics.all()),
      POST: async (req) => {
        const body = await readBody(req);
        if (!body.nom) return json({ error: "nom required" }, 400);
        const info = stmts.insertTopic.run({ $nom: body.nom, $description: body.description || "" });
        return json({ ok: true, id: info.lastInsertRowid }, 201);
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
        const topicQuery = body.topic?.trim();
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

    "/api/llm-status": {
      GET: async () => {
        const status = await checkLLMHealth();
        return json({ ...status, quota: getQuotaUsage() });
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

        isRelatedRunning = true;
        relatedJobId = createJobId();
        relatedProgress.total = 0;
        relatedProgress.completed = 0;
        relatedProgress.found = 0;
        relatedProgress.current = "";
        relatedProgress.status = "running";
        relatedProgress.results = [];
        relatedProgress.error = "";

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
            relatedProgress.results.push(result);
            relatedProgress.found = relatedProgress.results.length;
          }
        )
          .then(() => {
            relatedProgress.status = "done";
            relatedProgress.completed = relatedProgress.total;
          })
          .catch((err) => {
            relatedProgress.status = "error";
            relatedProgress.error = err.message;
            console.error("[Related] Discovery error:", err.message);
          })
          .finally(() => {
            isRelatedRunning = false;
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
          error: relatedProgress.error,
          results: relatedProgress.results.slice(sinceValue),
          next: relatedProgress.results.length,
        });
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

      // GET /api/quota
      if (method === "GET" && pathname === "/api/quota") {
        return json(getQuotaUsage());
      }

      // POST /api/channels/resolve-video
      if (method === "POST" && pathname === "/api/channels/resolve-video") {
        const body = await readBody(req);
        if (!body.url) return json({ error: "url required" }, 400);
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
      return json({ error: err.message }, 500);
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

  error(error) {
    console.error("[Server]", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`\n  YouFind running at http://localhost:${server.port}\n`);

// Start cron scheduler for automated tasks
startCron();
