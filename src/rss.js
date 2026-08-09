import { db, stmts } from "./db.js";
import { scrapeChannelVideos, isShortByText } from "./youtube-api.js";
import { runWithLimit } from "./utils.js";


const RSS_BASE = "https://www.youtube.com/feeds/videos.xml?channel_id=";

function extractBetween(xml, startTag, endTag) {
  const start = xml.indexOf(startTag);
  if (start === -1) return "";
  const from = start + startTag.length;
  const end = xml.indexOf(endTag, from);
  if (end === -1) return xml.substring(from);
  return xml.substring(from, end);
}

function extractAttr(xml, tag, attr) {
  const tagStart = xml.indexOf(`<${tag}`);
  if (tagStart === -1) return "";
  const tagEnd = xml.indexOf(">", tagStart);
  const tagContent = xml.substring(tagStart, tagEnd + 1);
  const attrStart = tagContent.indexOf(`${attr}="`);
  if (attrStart === -1) return "";
  const valStart = attrStart + attr.length + 2;
  const valEnd = tagContent.indexOf('"', valStart);
  return tagContent.substring(valStart, valEnd);
}

function parseEntries(xml) {
  const entries = [];
  let pos = 0;

  while (true) {
    const entryStart = xml.indexOf("<entry>", pos);
    if (entryStart === -1) break;
    const entryEnd = xml.indexOf("</entry>", entryStart);
    if (entryEnd === -1) break;

    const entry = xml.substring(entryStart, entryEnd + 8);
    pos = entryEnd + 8;

    const videoId = extractBetween(entry, "<yt:videoId>", "</yt:videoId>");
    if (!videoId) continue;

    const title = extractBetween(entry, "<title>", "</title>")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');

    const link = extractBetween(entry, '<link rel="alternate" href="', '"');
    const published = extractBetween(entry, "<published>", "</published>");
    const description = extractBetween(entry, "<media:description>", "</media:description>")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n/g, " ")
      .trim();

    const thumbnail = extractAttr(entry, "media:thumbnail", "url");

    const viewsStr = extractBetween(entry, '<media:statistics views="', '"');
    const views = parseInt(viewsStr) || 0;

    entries.push({
      videoId,
      titre: title,
      url: link || `https://www.youtube.com/watch?v=${videoId}`,
      date_pub: published,
      description: description.substring(0, 2000),
      thumbnail,
      vues: views,
      duration: 0, // will be scraped later from video page
    });
  }

  return entries;
}

// Scrape duration from video page (FREE, no API)
const durationCache = new Map();
const DURATION_CACHE_MAX = 5000;
let activeRefreshPromise = null;
export async function scrapeVideoDuration(videoUrl) {
  // Extract video ID from URL
  const vId = videoUrl.match(/v=([\w-]+)/)?.[1];
  if (!vId) return 0;
  if (durationCache.has(vId)) {
    const cached = durationCache.get(vId);
    // Refresh insertion order so frequently-used durations stay hot.
    durationCache.delete(vId);
    durationCache.set(vId, cached);
    return cached;
  }

  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${vId}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return 0;
    const html = await res.text();
    // Extract lengthSeconds from ytInitialPlayerResponse JSON
    const match = html.match(/"lengthSeconds"\s*:\s*"?(\d+)"?/);
    const sec = parseInt(match?.[1]) || 0;
    if (durationCache.size >= DURATION_CACHE_MAX) {
      const oldest = durationCache.keys().next().value;
      if (oldest) durationCache.delete(oldest);
    }
    durationCache.set(vId, sec);
    return sec;
  } catch {
    return 0;
  }
}

export async function fetchChannelFeed(channelId) {
  const url = RSS_BASE + channelId;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "YouFind/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`[RSS] Failed for ${channelId}: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return parseEntries(xml);
  } catch (err) {
    console.error(`[RSS] Error fetching ${channelId}:`, err.message);
    return [];
  }
}




export async function ingestChannel(channelId, { maxVideos = 0 } = {}) {
  // Deep-crawl a brand-new channel (100 videos). For re-refreshes the newest
  // uploads are always in the latest ~30, so skip the expensive continuation
  // fetches and only grab the first page. An explicit maxVideos (e.g. the
  // full-catalog refresh) overrides both defaults.
  const hasExistingVideos = !!db.query(`SELECT 1 FROM videos WHERE channel_id = ? LIMIT 1`).get(channelId);
  if (!maxVideos) maxVideos = hasExistingVideos ? 30 : 100;

  // Try free scraping first; fall back to RSS if scraping fails
  let entries = await scrapeChannelVideos(channelId, maxVideos);
  let source = "scrape";
  if (!entries.length) {
    entries = await fetchChannelFeed(channelId);
    source = "rss";
  }

  // Resolve durations in bulk. Entries scraped from the channel page already
  // carry their duration (parsed from lengthText). For anything left over
  // (RSS fallback), one extra page fetch fills a videoId → duration map
  // instead of one HTTP request per video.
  let durationMap = null;
  if (entries.some((e) => !e.duration)) {
    const pageVideos = await scrapeChannelVideos(channelId, 30);
    durationMap = new Map(
      pageVideos.filter((v) => v.duration > 0).map((v) => [v.videoId, v.duration])
    );
  }

  // Filter obvious Shorts by text immediately
  let filtered = entries.filter((e) => !isShortByText(e.titre, e.description));
  let skippedTextShorts = entries.length - filtered.length;

  let added = 0;
  let durUpdated = 0;
  let updated = 0;
  let skippedDurationShorts = 0;

  // Mostly local DB work now — durations come from the page scrape itself.
  await runWithLimit(
    filtered,
    async (entry) => {
      const existing = stmts.getVideoByUrl.get(entry.url);

      // Use the duration parsed from the channel page when available; only fall
      // back to a per-video fetch when no page could be parsed at all.
      let dur = entry.duration || 0;
      if (existing?.duration) {
        dur = existing.duration;
      } else if (!dur) {
        if (durationMap) dur = durationMap.get(entry.videoId) || 0;
        if (!dur && !durationMap) dur = await scrapeVideoDuration(entry.url);
      }

      // Exclude Shorts as soon as we know the duration
      if (dur > 0 && dur < 60) {
        skippedDurationShorts++;
        return;
      }

      stmts.insertVideo.run({
        $channel_id: channelId,
        $titre: entry.titre || "Sans titre",
        $description: entry.description || "",
        $url: entry.url,
        $thumbnail: entry.thumbnail || "",
        $date_pub: entry.date_pub || null,
        $vues: Number.isFinite(entry.vues) ? entry.vues : 0,
        $duration: dur,
      });
      if (!existing) {
        added++;
      } else {
        updated++;
        if (dur > 0 && !existing.duration) durUpdated++;
      }
    },
    3
  );

  if (skippedTextShorts > 0 || skippedDurationShorts > 0) {
    console.log(`[Ingest] Shorts excluded for ${channelId}: ${skippedTextShorts} by text, ${skippedDurationShorts} by duration`);
  }

  return { total: entries.length, added, updated, durUpdated, source };
}

// Channels refreshed more recently than this are skipped by the bulk refresh:
// nothing new can have been published in between, and it keeps repeated manual
// refreshes (e.g. right after the daily cron run) near-instant.
const REFRESH_SKIP_WINDOW_MS = 30 * 60 * 1000;

// Full-catalog crawl: fetch up to this many videos per channel (vs 30-100 for
// the regular refresh). Most channels have fewer than 500, so in practice this
// grabs their whole backlog.
export const DEEP_REFRESH_MAX_VIDEOS = 500;

// Deep-crawl a single channel (full backlog) and mark it as freshly refreshed.
export async function deepIngestChannel(channelId) {
  const result = await ingestChannel(channelId, { maxVideos: DEEP_REFRESH_MAX_VIDEOS });
  stmts.updateChannelLastRefresh.run(String(Date.now()), channelId);
  return result;
}

export async function refreshAllVideos(onProgress) {
  const channels = stmts.getChannelsByStatus.all("validated");
  const results = [];
  const total = channels.length;
  let refreshed = 0;

  // No freshness skip here: the user asked for the full catalog explicitly.
  // Lower concurrency than the RSS refresh because each channel does a deep crawl.
  await runWithLimit(
    channels,
    async (ch, idx) => {
      console.log(`[RSS] Deep refresh ${ch.nom} (${ch.channel_id})...`);
      if (onProgress) onProgress({ current: idx, total, nom: ch.nom, status: "running" });
      try {
        const result = await deepIngestChannel(ch.channel_id);
        refreshed++;
        results.push({ channel: ch.nom, ...result });
        if (onProgress) onProgress({ current: idx + 1, total, nom: ch.nom, status: "done", result });
      } catch (e) {
        console.error(`[RSS] Error deep-refreshing ${ch.nom}:`, e.message);
        if (onProgress) onProgress({ current: idx + 1, total, nom: ch.nom, status: "error", error: e.message });
      }
    },
    3,
    300
  );

  console.log(`[RSS] Deep refresh done: ${refreshed} channels.`);
  return results;
}

// Deep-crawl only the pending channels that have no videos at all yet, so the
// user can preview what they publish before deciding to accept or reject.
export async function refreshPendingWithoutVideos(onProgress) {
  const channels = stmts.getPendingChannelsWithoutVideos.all();
  const results = [];
  const total = channels.length;
  let refreshed = 0;

  await runWithLimit(
    channels,
    async (ch, idx) => {
      console.log(`[RSS] Deep crawl pending ${ch.nom} (${ch.channel_id})...`);
      if (onProgress) onProgress({ current: idx, total, nom: ch.nom, status: "running" });
      try {
        const result = await deepIngestChannel(ch.channel_id);
        refreshed++;
        results.push({ channel: ch.nom, ...result });
        if (onProgress) onProgress({ current: idx + 1, total, nom: ch.nom, status: "done", result });
      } catch (e) {
        console.error(`[RSS] Error deep-crawling pending ${ch.nom}:`, e.message);
        if (onProgress) onProgress({ current: idx + 1, total, nom: ch.nom, status: "error", error: e.message });
      }
    },
    3,
    300
  );

  console.log(`[RSS] Pending deep crawl done: ${refreshed} channels.`);
  return results;
}

async function refreshAllChannelsImpl(onProgress) {
  const channels = stmts.getChannelsByStatus.all("validated");
  const results = [];
  const total = channels.length;
  let refreshed = 0;
  let skipped = 0;

  await runWithLimit(
    channels,
    async (ch, idx) => {
      const lastRefresh = Number(ch.last_refresh);
      if (ch.last_refresh && Number.isFinite(lastRefresh) && Date.now() - lastRefresh < REFRESH_SKIP_WINDOW_MS) {
        skipped++;
        results.push({ channel: ch.nom, skipped: true });
        if (onProgress) onProgress({ current: idx + 1, total, nom: ch.nom, status: "done", skipped: true });
        return;
      }

      console.log(`[RSS] Refreshing ${ch.nom} (${ch.channel_id})...`);
      if (onProgress) onProgress({ current: idx, total, nom: ch.nom, status: "running" });
      try {
        const result = await ingestChannel(ch.channel_id);
        refreshed++;
        stmts.updateChannelLastRefresh.run(String(Date.now()), ch.channel_id);
        results.push({ channel: ch.nom, ...result });
        if (onProgress) onProgress({ current: idx + 1, total, nom: ch.nom, status: "done", result });
      } catch (e) {
        console.error(`[RSS] Error refreshing ${ch.nom}:`, e.message);
        if (onProgress) onProgress({ current: idx + 1, total, nom: ch.nom, status: "error", error: e.message });
      }
    },
    5,
    200
  );

  console.log(`[RSS] Refreshed ${refreshed} channels, skipped ${skipped} (recently refreshed).`);
  return results;
}

export function refreshAllChannels(onProgress) {
  if (activeRefreshPromise) return activeRefreshPromise;

  activeRefreshPromise = refreshAllChannelsImpl(onProgress).finally(() => {
    activeRefreshPromise = null;
  });
  return activeRefreshPromise;
}

export async function getChannelVideoSummaries(channelId, count = 5) {
  // Try scraping first (more reliable than RSS)
  let scraped = await scrapeChannelVideos(channelId, count);
  if (scraped.length > 0) {
    return scraped.slice(0, count).map((e) => ({
      titre: e.titre,
      description: e.description?.substring(0, 500) || "",
      vues: e.vues,
    }));
  }
  // Fallback to RSS
  const entries = await fetchChannelFeed(channelId);
  return entries.slice(0, count).map((e) => ({
    titre: e.titre,
    description: e.description.substring(0, 500),
    vues: e.vues,
  }));
}

if (process.argv[1] && process.argv[1].endsWith("rss.js")) {
  console.log("[RSS] Manual refresh starting...");
  const results = await refreshAllChannels();
  console.log(JSON.stringify(results, null, 2));
}
