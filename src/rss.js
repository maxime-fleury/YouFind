import { stmts } from "./db.js";
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
export async function scrapeVideoDuration(videoUrl) {
  // Extract video ID from URL
  const vId = videoUrl.match(/v=([\w-]+)/)?.[1];
  if (!vId) return 0;
  if (durationCache.has(vId)) return durationCache.get(vId);

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
    if (durationCache.size >= DURATION_CACHE_MAX) durationCache.clear();
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




export async function ingestChannel(channelId) {
  // Try free scraping first; fall back to RSS if scraping fails
  let entries = await scrapeChannelVideos(channelId, 100);
  let source = "scrape";
  if (!entries.length) {
    entries = await fetchChannelFeed(channelId);
    source = "rss";
  }

  // Filter obvious Shorts by text immediately
  let filtered = entries.filter((e) => !isShortByText(e.titre, e.description));
  let skippedTextShorts = entries.length - filtered.length;

  let added = 0;
  let durUpdated = 0;
  let skippedDurationShorts = 0;

  // Scrape duration with limited concurrency (5 parallel) so 100 videos don't take forever
  await runWithLimit(
    filtered,
    async (entry) => {
      const existing = stmts.getVideoByUrl.get(entry.url);

      // Scrape duration for videos missing it (new or old)
      let dur = 0;
      if (!existing || !existing.duration) {
        dur = await scrapeVideoDuration(entry.url);
      } else {
        dur = existing.duration;
      }

      // Exclude Shorts as soon as we know the duration
      if (dur > 0 && dur < 60) {
        skippedDurationShorts++;
        return;
      }

      if (!existing) {
        stmts.insertVideo.run({
          $channel_id: channelId,
          $titre: entry.titre,
          $description: entry.description,
          $url: entry.url,
          $thumbnail: entry.thumbnail,
          $date_pub: entry.date_pub,
          $vues: entry.vues,
          $duration: dur,
        });
        added++;
      } else if (dur > 0 && !existing.duration) {
        stmts.updateVideoDuration.run({ $duration: dur, $url: entry.url });
        durUpdated++;
      }
    },
    3
  );

  if (skippedTextShorts > 0 || skippedDurationShorts > 0) {
    console.log(`[Ingest] Shorts excluded for ${channelId}: ${skippedTextShorts} by text, ${skippedDurationShorts} by duration`);
  }

  return { total: entries.length, added, durUpdated, source };
}

export async function refreshAllChannels() {
  const channels = stmts.getChannelsByStatus.all("validated");
  const results = [];

  await runWithLimit(
    channels,
    async (ch) => {
      console.log(`[RSS] Refreshing ${ch.nom} (${ch.channel_id})...`);
      const result = await ingestChannel(ch.channel_id);
      results.push({ channel: ch.nom, ...result });
    },
    3,
    500
  );

  console.log(`[RSS] Refreshed ${channels.length} channels.`);
  return results;
}

export async function getChannelVideoSummaries(channelId, count = 5) {
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
