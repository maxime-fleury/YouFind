import { join, dirname, resolve, relative } from "path";
import { db, stmts, getSetting, setSetting, getAllSettings } from "./db.js";
import { ingestChannel, refreshAllChannels } from "./rss.js";
import { discoverFromTopic, getQuotaUsage, resolveChannel, scrapeChannelInfo, resolveFromVideoUrl, scrapeRelatedChannels, extractChannelIdsFromText, discoverRelatedFromValidated } from "./youtube-api.js";
import { scoreChannel, scoreAllPending, scoreAllUnscored, rescoreAllChannels, checkLLMHealth } from "./llm.js";
import { startCron } from "./cron.js";

const PORT = parseInt(Bun.env.PORT || "3000");
const HOST = Bun.env.HOST || "127.0.0.1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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
let isRefreshingStats = false;
const refreshProgress = { total: 0, completed: 0, errors: 0, current: "", status: "idle" };

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

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  routes: {
    "/api/stats": {
      GET: () => json(stmts.getStats.get()),
    },

    "/api/videos": {
      GET: (req) => {
        const url = new URL(req.url);
        const limit = parseInt(url.searchParams.get("limit") || "60");
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const channel = url.searchParams.get("channel");
        const topic = url.searchParams.get("topic");
        const search = url.searchParams.get("q")?.trim() || "";
        // Build a safe prefix-match FTS5 query: term1* AND term2*
        const rawTerms = search.replace(/['"]/g, "").split(/\s+/).filter((t) => t.length > 0).map((t) => t.replace(/[^\w\-]/g, ""));
        const hasSearch = rawTerms.length > 0;
        const sort = url.searchParams.get("sort") || (hasSearch ? "relevance" : "newest");

        const sortClauses = {
          newest: "v.date_pub DESC",
          views: "v.vues DESC",
          engagement: "CASE WHEN c.subscriber_count > 0 THEN CAST(v.vues AS REAL) / c.subscriber_count ELSE 0 END DESC",
          score: "c.llm_score DESC NULLS LAST",
          relevance: hasSearch ? "bm25(fts) ASC" : "v.date_pub DESC",
        };
        if (!sortClauses[sort]) {
          return json({ error: "Invalid sort" }, 400);
        }

        // Build query dynamically
        const joins = [];
        const conditions = ["c.status = 'validated'", "v.duration > 60"];
        const params = [];

        if (hasSearch) {
          joins.push("JOIN videos_fts fts ON v.id = fts.rowid");
          const ftsQuery = rawTerms.map((t) => `"${t}"*`).join(" AND ");
          conditions.push("fts MATCH ?");
          params.push(ftsQuery);
        }

        if (topic === "0") {
          conditions.push("NOT EXISTS (SELECT 1 FROM channel_topics ct WHERE ct.channel_id = v.channel_id)");
        } else if (topic) {
          joins.push("JOIN channel_topics ct ON v.channel_id = ct.channel_id");
          conditions.push("ct.topic_id = ?");
          params.push(parseInt(topic));
        } else if (channel) {
          conditions.push("v.channel_id = ?");
          params.push(channel);
        }

        params.push(limit, offset);

        const rankSelect = search ? ", bm25(fts) as rank" : "";
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
        let channels;
        if (status === "rejected") {
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
            const preview_videos = db.query(
              `SELECT titre, thumbnail, vues, url FROM videos WHERE channel_id = ? ORDER BY date_pub DESC LIMIT 3`
            ).all(ch.channel_id);
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
        const id = parseInt(req.params.id);
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
        const id = parseInt(req.params.id);
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
      POST: async (req) => {
        const id = parseInt(req.params.id);
        const ch = db.query(`SELECT channel_id FROM channels WHERE id = ?`).get(id);
        if (!ch) return json({ error: "Channel not found" }, 404);

        const result = await scoreChannel(ch.channel_id);
        return json(result || { error: "Scoring failed" });
      },
    },

    "/api/ingest/:channelId": {
      POST: async (req) => {
        const channelId = req.params.channelId;
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
        const id = parseInt(url.searchParams.get("id"));
        if (!id) return json({ error: "id required" }, 400);
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
      POST: async () => {
        const results = await scoreAllPending();
        return json({ ok: true, scored: results.length, results });
      },
    },

    "/api/score-unscored": {
      POST: async () => {
        const results = await scoreAllUnscored();
        return json({ ok: true, scored: results.length, results });
      },
    },

    "/api/rescore-all": {
      POST: async () => {
        const results = await rescoreAllChannels();
        return json({ ok: true, scored: results.length, results });
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
        const limit = parseInt(url.searchParams.get("limit") || "20");
        const feedback = stmts.getRecentRejections.all(limit);
        return json(feedback);
      },
    },

    "/api/settings": {
      GET: () => {
        const settings = getAllSettings();
        return json(settings);
      },
      POST: async (req) => {
        const body = await readBody(req);
        for (const [key, value] of Object.entries(body)) {
          if (typeof value === "string") {
            setSetting(key, value);
          }
        }
        return json({ ok: true, settings: getAllSettings() });
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
      // POST /api/discover/related
      if (method === "POST" && pathname === "/api/discover/related") {
        const results = await discoverRelatedFromValidated();
        return json({ ok: true, found: results.length, channels: results });
      }

      // --- API routes handled in fetch (bypass Bun router quirks) ---

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
        const chanId = parseInt(topicsMatch[1]);
        const ch = db.query(`SELECT channel_id FROM channels WHERE id = ?`).get(chanId);
        if (!ch) return json({ error: "Channel not found" }, 404);

        if (method === "GET") {
          return json(stmts.getChannelTopics.all(ch.channel_id));
        }
        if (method === "POST") {
          const body = await readBody(req);
          if (!body.topic_id) return json({ error: "topic_id required" }, 400);
          stmts.assignTopic.run(ch.channel_id, parseInt(body.topic_id));
          return json({ ok: true });
        }
        if (method === "DELETE") {
          const topicId = parseInt(url.searchParams.get("topic_id"));
          if (!topicId) return json({ error: "topic_id required" }, 400);
          stmts.removeTopic.run(ch.channel_id, topicId);
          return json({ ok: true });
        }
        return json({ error: "Method not allowed" }, 405);
      }

      // GET /api/channels/:id/related
      const relatedMatch = pathname.match(/^\/api\/channels\/(\d+)\/related$/);
      if (relatedMatch && method === "GET") {
        const chanId = parseInt(relatedMatch[1]);
        const ch = db.query(`SELECT channel_id FROM channels WHERE id = ?`).get(chanId);
        if (!ch) return json({ error: "Channel not found" }, 404);
        const related = await scrapeRelatedChannels(ch.channel_id);
        return json(related);
      }

      // GET /api/channels/:id/preview (3 recent videos for validation preview)
      const previewMatch = pathname.match(/^\/api\/channels\/(\d+)\/preview$/);
      if (previewMatch && method === "GET") {
        const chanId = parseInt(previewMatch[1]);
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
        const chanId = parseInt(detailMatch[1]);
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
