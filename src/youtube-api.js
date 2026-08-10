import { db, stmts } from "./db.js";
import { runWithLimit } from "./utils.js";
import { extractChannelIdsFromText, isShortByText, parseChannelInput } from "./youtube-parsers.js";

export { extractChannelIdsFromText, isShortByText, parseChannelInput };

const pageCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_SIZE = 200;

function getCachedPage(url) {
  const entry = pageCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL_MS) {
    pageCache.delete(url);
    return null;
  }
  return entry.data;
}

function setCachedPage(url, data) {
  if (pageCache.size >= CACHE_MAX_SIZE) {
    const firstKey = pageCache.keys().next().value;
    pageCache.delete(firstKey);
  }
  pageCache.set(url, { data, time: Date.now() });
}

async function fetchPageText(url, { retries = 1, signal = null } = {}) {
  const cached = getCachedPage(url);
  if (cached !== null) return cached;

  for (let attempt = 0; ; attempt++) {
    try {
      if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort(signal?.reason);
      signal?.addEventListener("abort", abortRequest, { once: true });
      const timeout = setTimeout(() => requestController.abort(), 30000);
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        // Channel pages are heavy (~750KB); 15s was too tight when several
        // deep crawls ran concurrently and YouTube slowed down.
        signal: requestController.signal,
      }).finally(() => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortRequest);
      });
      if (res.ok) {
        const text = await res.text();
        setCachedPage(url, text);
        return text;
      }
      // Transient server errors (429 rate-limit, 5xx) can recover on retry;
      // 4xx are final and won't improve. Failures are never cached.
      if (res.status >= 500 || res.status === 429) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
      }
      return "";
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function extractFromHTML(html) {
  const channelIdMatch = html.match(/"channelId"\s*:\s*"(UC[\w-]{22})"/);
  const channelId = channelIdMatch?.[1] || "";

  const nameMatch = html.match(/<title>([^<]+)<\/title>/);
  let name = nameMatch?.[1] || "";
  name = decodeHtmlEntities(name).replace(/\s*-\s*YouTube\s*$/, "").trim();

  let description = "";
  const dataMatch = html.match(/var ytInitialData = ({[\s\S]*?});<\/script>/);
  if (dataMatch) {
    try {
      const data = JSON.parse(dataMatch[1]);
      description = data?.metadata?.channelMetadataRenderer?.description || "";
    } catch {}
  }
  if (!description) {
    const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (metaDesc) description = decodeHtmlEntities(metaDesc[1]);
  }
  description = description.replace(/\s+/g, " ").trim().slice(0, 1000);

  const thumbMatch = html.match(/"avatar"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
  const thumbnail = thumbMatch?.[1] || "";

  const subsMatch = html.match(/"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+)"/);
  const subsText = subsMatch?.[1] || "";

  let subscriberCount = 0;
  if (subsText) {
    // Normalize: "1 500" → "1500", "1,5k" → "1.5k", "1,500" depends on locale
    let normalized = subsText.replace(/\s/g, "");
    // If comma is followed by exactly 3 digits, it's a thousands separator (English)
    // Otherwise it's a decimal separator (French)
    if (/,(\d{3})\b/.test(normalized)) {
      normalized = normalized.replace(/,/g, "");
    } else {
      normalized = normalized.replace(/,/g, ".");
    }
    const numMatch = normalized.match(/([\d.]+)\s*(K|M|Mi|abonn)/i) || normalized.match(/([\d.]+)/);
    if (numMatch) {
      let n = parseFloat(numMatch[1]);
      if (numMatch[2]) {
        if (/K|Ki/i.test(numMatch[2])) n *= 1000;
        else if (/M|Mi/i.test(numMatch[2])) n *= 1000000;
      }
      subscriberCount = Math.round(n);
    }
  }

  return { channelId, name, thumbnail, subscriberCount, description };
}

// Scrape channel page for stats — FREE, zero API cost
export async function scrapeChannelInfo(channelId) {
  try {
    const html = await fetchPageText(`https://www.youtube.com/channel/${channelId}`);
    if (!html) return { subscriberCount: 0, thumbnail: "", name: "", description: "" };
    const data = extractFromHTML(html);
    return { subscriberCount: data.subscriberCount, thumbnail: data.thumbnail, name: data.name || "", description: data.description || "" };
  } catch {
    return { subscriberCount: 0, thumbnail: "", name: "", description: "" };
  }
}

// --- Free scraping of channel video list (no API key needed) ---

function extractYtInitialData(html) {
  const match = html.match(/var ytInitialData = ({[\s\S]*?});<\/script>/);
  if (!match) {
    // Try alternate patterns
    const altMatch = html.match(/ytInitialData\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (altMatch) {
      try { return JSON.parse(altMatch[1]); } catch { return null; }
    }
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractInnertubeKey(html) {
  // Prefer the key embedded in ytcfg
  const match = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  if (match) return match[1];
  return null;
}

function parseViewCount(text) {
  if (!text) return 0;
  // "1,234 views", "12K views", "1.5M views", "12 k vues", "1,5K vues"
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const m = normalized.match(/([\d.,]+)\s*(k|m|b)?/);
  if (!m) return 0;
  const unit = m[2];
  let numStr = m[1];
  if (unit && numStr.includes(",")) {
    // Comma is a decimal separator when a unit is present, e.g. "1,5K"
    numStr = numStr.replace(/,/g, ".");
  } else {
    // Comma is a thousands separator
    numStr = numStr.replace(/,/g, "");
  }
  let n = parseFloat(numStr);
  if (!n) return 0;
  if (unit === "k") n *= 1000;
  else if (unit === "m") n *= 1000000;
  else if (unit === "b") n *= 1000000000;
  return Math.round(n);
}

function parseDurationToSeconds(text) {
  if (!text) return 0;
  const t = String(text).trim();
  if (!t || t.toLowerCase().includes("live")) return 0;
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3) return 0;
  let secs = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0) return 0;
    secs = secs * 60 + n;
  }
  return secs;
}

function parseRelativeTime(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  const now = new Date();
  let m;

  const apply = (value, unit) => {
    const d = new Date(now);
    if (unit === "second") d.setSeconds(d.getSeconds() - value);
    if (unit === "minute") d.setMinutes(d.getMinutes() - value);
    if (unit === "hour") d.setHours(d.getHours() - value);
    if (unit === "day") d.setDate(d.getDate() - value);
    if (unit === "week") d.setDate(d.getDate() - value * 7);
    if (unit === "month") d.setMonth(d.getMonth() - value);
    if (unit === "year") d.setFullYear(d.getFullYear() - value);
    return d.toISOString();
  };

  if (t.includes("just now") || t.includes("à l'instant")) return now.toISOString();
  if (t.includes("today") || t.includes("aujourd'hui")) return now.toISOString();
  if (t.includes("yesterday") || t.includes("hier")) return apply(1, "day");

  // "X minutes ago", "il y a X minutes", "X min"
  m = t.match(/(?:il y a )?(\d+)\s*min(?:ute)?s?/);
  if (m) return apply(parseInt(m[1]), "minute");

  // "X hours ago", "il y a X heures"
  m = t.match(/(?:il y a )?(\d+)\s*(?:hours?|heures?|hr?)/);
  if (m) return apply(parseInt(m[1]), "hour");

  // "X days ago", "il y a X jours"
  m = t.match(/(?:il y a )?(\d+)\s*(?:days?|jours?)/);
  if (m) return apply(parseInt(m[1]), "day");

  // "X weeks ago", "il y a X semaines"
  m = t.match(/(?:il y a )?(\d+)\s*(?:weeks?|semaines?)/);
  if (m) return apply(parseInt(m[1]), "week");

  // "X months ago", "il y a X mois"
  m = t.match(/(?:il y a )?(\d+)\s*(?:months?|mois)/);
  if (m) return apply(parseInt(m[1]), "month");

  // "X years ago", "il y a X ans"
  m = t.match(/(?:il y a )?(\d+)\s*(?:years?|ans?)/);
  if (m) return apply(parseInt(m[1]), "year");

  return null;
}

function parseGridVideo(item) {
  // Old format: gridVideoRenderer / videoRenderer
  const r = item.gridVideoRenderer || item.richItemRenderer?.content?.videoRenderer;
  if (r && r.videoId) {
    let title = "";
    if (r.title?.simpleText) title = r.title.simpleText;
    else if (r.title?.runs) title = r.title.runs.map((run) => run.text).join("");

    let thumbnails = r.thumbnail?.thumbnails || r.thumbnail;
    let thumbnail = "";
    if (Array.isArray(thumbnails) && thumbnails.length > 0) {
      thumbnail = thumbnails[thumbnails.length - 1].url;
    }

    let viewsText = "";
    if (r.viewCountText?.simpleText) viewsText = r.viewCountText.simpleText;
    else if (r.viewCountText?.runs) viewsText = r.viewCountText.runs.map((run) => run.text).join("");

    let publishedTime = "";
    if (r.publishedTimeText?.simpleText) publishedTime = r.publishedTimeText.simpleText;

    // Duration is available for free in the page HTML (e.g. "12:34") — no
    // need to fetch each video page individually.
    const duration = parseDurationToSeconds(r.lengthText?.simpleText);

    return {
      videoId: r.videoId,
      titre: title,
      url: `https://www.youtube.com/watch?v=${r.videoId}`,
      date_pub: parseRelativeTime(publishedTime),
      description: "",
      thumbnail,
      vues: parseViewCount(viewsText),
      duration,
    };
  }

  // New format: richItemRenderer → content → lockupViewModel
  const lockup = item.richItemRenderer?.content?.lockupViewModel;
  if (!lockup) return null;

  // Extract videoId from the overlay badge target or thumbnail URL
  const badgeTarget = lockup.contentImage?.thumbnailViewModel?.overlays?.[0]
    ?.thumbnailBottomOverlayViewModel?.badges?.[0]
    ?.thumbnailBadgeViewModel?.animationActivationTargetId;
  const thumbUrl = lockup.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url || "";
  const videoId = (badgeTarget?.length === 11 ? badgeTarget : null) || thumbUrl.match(/\/vi\/([\w-]+)\//)?.[1];
  if (!videoId) return null;

  // Title
  const title = lockup.metadata?.lockupMetadataViewModel?.title?.content || "";

  // Thumbnail (largest)
  const sources = lockup.contentImage?.thumbnailViewModel?.image?.sources || [];
  const thumbnail = sources.length > 0 ? sources[sources.length - 1].url : "";

  // Views and publish time from metadata rows
  const parts = lockup.metadata?.lockupMetadataViewModel?.metadata
    ?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts || [];
  const viewsText = parts[0]?.text?.content || "";
  const publishedTime = parts[1]?.text?.content || "";

  // Duration from the thumbnail overlay badge (e.g. "12:34"). Fall back to any
  // duration-shaped string in the payload; requiring 2-digit seconds avoids
  // false positives like aspect ratios ("16:9").
  let duration = 0;
  const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || [];
  for (const ov of overlays) {
    const badges = ov?.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const d = parseDurationToSeconds(badge?.thumbnailBadgeViewModel?.text);
      if (d > 0) { duration = d; break; }
    }
    if (duration > 0) break;
  }
  if (!duration) {
    const m = JSON.stringify(lockup).match(/"(\d+:\d{2}(?::\d{2})?)"/);
    if (m) duration = parseDurationToSeconds(m[1]);
  }

  return {
    videoId,
    titre: title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    date_pub: parseRelativeTime(publishedTime),
    description: "",
    thumbnail,
    vues: parseViewCount(viewsText),
    duration,
  };
}

function isVideosTab(tab) {
  const id = tab?.tabRenderer?.tabIdentifier;
  if (id === "VIDEOS" || id === "Videos") return true;
  const title = tab?.tabRenderer?.title?.toLowerCase();
  return title === "videos" || title === "vidéos" || title === "video" || title === "vidéo";
}

function getTabContentItems(videoTab) {
  const content = videoTab?.tabRenderer?.content;
  // New layout: richGridRenderer directly on content
  if (content?.richGridRenderer?.contents) return content.richGridRenderer.contents;
  // Old layout: sectionListRenderer wrapping item/grid renderers
  const sections = content?.sectionListRenderer?.contents || [];
  const items = [];
  for (const section of sections) {
    const sectionItems = section.itemSectionRenderer?.contents?.[0]?.gridRenderer?.items ||
                         section.itemSectionRenderer?.contents?.[0]?.richGridRenderer?.contents ||
                         [];
    items.push(...sectionItems);
  }
  return items;
}

function getTabContinuations(videoTab) {
  const content = videoTab?.tabRenderer?.content;
  // Current layout: richGridRenderer.continuations is usually empty — the token
  // lives in the last contents item as a continuationItemRenderer instead.
  if (content?.richGridRenderer?.continuations) return content.richGridRenderer.continuations;
  if (content?.richGridRenderer?.contents) {
    const last = content.richGridRenderer.contents[content.richGridRenderer.contents.length - 1];
    if (last?.continuationItemRenderer) return [last.continuationItemRenderer];
  }
  // Old layout: sectionListRenderer continuations
  const sections = content?.sectionListRenderer?.contents || [];
  for (const section of sections) {
    const cont = section.itemSectionRenderer?.contents?.[0]?.gridRenderer?.continuations;
    if (cont) return cont;
  }
  if (content?.sectionListRenderer?.continuations) return content.sectionListRenderer.continuations;
  return [];
}

function extractGridVideos(data) {
  const videos = [];
  try {
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    const videoTab = tabs.find(isVideosTab);
    const items = getTabContentItems(videoTab);
    for (const item of items) {
      const v = parseGridVideo(item);
      if (v) videos.push(v);
    }
  } catch (err) {
    console.error("[Scrape] Error extracting grid videos:", err.message);
  }
  return videos;
}

function extractContinuation(data) {
  try {
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    const videoTab = tabs.find(isVideosTab);
    const continuations = getTabContinuations(videoTab);
    for (const c of continuations) {
      if (c.nextContinuationData?.continuation) return c.nextContinuationData.continuation;
      if (c.button?.buttonRenderer?.command?.continuationCommand?.token) return c.button.buttonRenderer.command.continuationCommand.token;
      if (c.continuationEndpoint?.continuationCommand?.token) return c.continuationEndpoint.continuationCommand.token;
    }
  } catch {}
  return null;
}

async function fetchContinuation(continuation, apiKey, clientVersion = "2.20240101.00.00") {
  const url = apiKey ? `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}` : "https://www.youtube.com/youtubei/v1/browse";
  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion,
        hl: "en",
        gl: "US",
        visitorData: "",
      },
    },
    continuation,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify(body),
    // Continuation fetches had no timeout at all and could hang forever.
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  return res.json();
}

function extractContinuationVideos(data) {
  const videos = [];
  try {
    const items = data?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems ||
                  data?.onResponseReceivedActions?.[0]?.reloadContinuationItemsAction?.continuationItems ||
                  [];
    for (const item of items) {
      const v = parseGridVideo(item);
      if (v) videos.push(v);
    }
  } catch {}
  return videos;
}

function extractContinuationToken(data) {
  try {
    const items = data?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems ||
                  data?.onResponseReceivedActions?.[0]?.reloadContinuationItemsAction?.continuationItems ||
                  [];
    for (const item of items) {
      if (item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
        return item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      }
    }
  } catch {}
  return null;
}

export async function scrapeChannelVideos(channelId, maxResults = 100) {
  try {
    const html = await fetchPageText(`https://www.youtube.com/channel/${channelId}/videos`);
    if (!html) return [];
    const data = extractYtInitialData(html);
    if (!data) return [];
    const apiKey = extractInnertubeKey(html);

    let videos = extractGridVideos(data);
    let token = extractContinuation(data);
    let fetched = 0;

    // Scale the continuation budget with the target: each fetch yields ~30
    // videos, so a deep crawl (e.g. maxResults=500) needs more rounds than a
    // shallow one. +2 leaves headroom for pages that parse fewer items.
    const maxFetches = Math.ceil(maxResults / 25) + 2;
    while (videos.length < maxResults && token && fetched < maxFetches) {
      const contData = await fetchContinuation(token, apiKey);
      if (!contData) break;
      const newVideos = extractContinuationVideos(contData);
      if (newVideos.length === 0) {
        token = extractContinuationToken(contData);
        if (!token) break;
      } else {
        videos.push(...newVideos);
        token = extractContinuationToken(contData) || null;
      }
      fetched++;
    }

    return videos.slice(0, maxResults);
  } catch (err) {
    console.error(`[Scrape] Failed to scrape videos for ${channelId}:`, err.message);
    return [];
  }
}

async function resolveFromHandle(handle) {
  const html = await fetchPageText(`https://www.youtube.com/@${handle}`);
  if (!html) return null;
  const data = extractFromHTML(html);
  if (!data.channelId) return null;
  return {
    channelId: data.channelId,
    nom: data.name || handle,
    thumbnail: data.thumbnail,
    subscriberCount: data.subscriberCount,
  };
}

async function resolveFromId(channelId) {
  const xml = await fetchPageText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!xml) return null;

  const titleMatch = xml.match(/<title>([^<]+)<\/title>/);
  const name = decodeHtmlEntities(titleMatch?.[1] || channelId);

  const thumbMatch = xml.match(/<media:thumbnail url="([^"]+)"/);
  const thumbnail = thumbMatch?.[1] || "";

  return { channelId, nom: name, thumbnail, subscriberCount: 0 };
}

async function resolveFromQuery(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%3D%3D`;
  const html = await fetchPageText(url);
  if (!html) return null;

  const results = [];
  const channelRegex = /"channelRenderer"\s*:\s*\{[^}]*"channelId"\s*:\s*"(UC[\w-]{22})"[^}]*?"title"\s*:\s*\{[^}]*?"runs"\s*:\s*\[\s*\{[^}]*?"text"\s*:\s*"([^"]+)"/g;
  let match;
  while ((match = channelRegex.exec(html)) !== null) {
    results.push({ channelId: match[1], nom: match[2] });
    if (results.length >= 5) break;
  }

  if (results.length === 0) {
    const altRegex = /"channelId"\s*:\s*"(UC[\w-]{22})"/g;
    const seen = new Set();
    while ((match = altRegex.exec(html)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        results.push({ channelId: match[1], nom: "" });
        if (results.length >= 5) break;
      }
    }
  }

  if (results.length === 0) return null;

  const best = results[0];
  if (!best.nom) {
    const resolved = await resolveFromId(best.channelId);
    if (resolved) best.nom = resolved.nom;
  }

  const thumbMatch = html.match(/"channelId"\s*:\s*"UC[\w-]{22}"[^}]*?"thumbnails"[^}]*?"url"\s*:\s*"([^"]+)"/);
  const thumbnail = thumbMatch?.[1] || "";

  return {
    channelId: best.channelId,
    nom: best.nom || query,
    thumbnail,
    subscriberCount: 0,
    alternatives: results.slice(1).filter((r) => r.nom).map((r) => ({ channelId: r.channelId, nom: r.nom })),
  };
}

export async function resolveChannel(input) {
  const parsed = parseChannelInput(input);
  console.log(`[Resolve] Type: ${parsed.type}, input: ${input.trim()}`);

  switch (parsed.type) {
    case "video":
      return resolveFromVideoUrl(parsed.videoUrl);
    case "id":
      return resolveFromId(parsed.channelId);
    case "handle":
      return resolveFromHandle(parsed.handle);
    case "query":
      return resolveFromQuery(parsed.query);
    default:
      return null;
  }
}

export async function discoverFromTopic(topicQuery, maxResults = 20, offset = 0) {
  const totalNeeded = Math.min(offset + maxResults, 60); // cap to avoid excessive scraping
  console.log(`[Discover] Searching channels for: "${topicQuery}" (offset ${offset}, max ${maxResults})`);

  const blacklisted = new Set(stmts.getBlacklistedChannelIds.all().map((r) => r.channel_id));
  const allExisting = db.query(`SELECT channel_id FROM channels`).all();
  const existingIds = new Set(allExisting.map((ch) => ch.channel_id));
  const excludedIds = new Set([...existingIds, ...blacklisted]);

  // First try scraping (FREE, zero API cost) — scrape extra to handle offset
  const scrapedChannels = await scrapeDiscoverChannels(topicQuery, totalNeeded);
  const sliced = scrapedChannels.slice(offset, offset + maxResults);
  if (sliced.length > 0) {
    console.log(`[Discover] Scraping found ${scrapedChannels.length} channels, returning ${sliced.length} (offset ${offset})`);
    const inserted = [];
    for (const ch of sliced) {
      if (excludedIds.has(ch.channelId)) continue;
      if (ch.subscriberCount < 100 && ch.subscriberCount !== 0) continue;
      stmts.insertChannel.run({
        $nom: ch.nom,
        $channel_id: ch.channelId,
        $subscriber_count: ch.subscriberCount,
        $last_video_date: null,
        $thumbnail: ch.thumbnail,
        $description: ch.description || "",
      });
      inserted.push(ch);
    }
    console.log(`[Discover] Scraped: ${sliced.length} shown, ${inserted.length} added as pending.`);
    return { channels: inserted, method: "scraping" };
  }

  // No API fallback: we stay 100% free scraping only.
  console.log("[Discover] Scraping found nothing.");
  return { channels: [], method: "scraping" };
}

// --- Scraping-based discovery (FREE, zero API cost) ---

export async function scrapeDiscoverChannels(query, maxResults = 20) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%3D%3D`;
  const html = await fetchPageText(url);
  if (!html) return [];

  console.log(`[Scrape] Fetched search page for "${query}"`);

  const results = [];
  const seen = new Set();

  // Try extracting channel renderers with names
  const channelRegex = /"channelRenderer"\s*:\s*\{[^}]*?"channelId"\s*:\s*"(UC[\w-]{22})"[^}]*?"title"\s*:\s*\{[^}]*?"text"\s*:\s*"([^"]+)"/g;
  let match;
  while ((match = channelRegex.exec(html)) !== null) {
    const cid = match[1];
    if (!seen.has(cid)) {
      seen.add(cid);
      results.push({ channelId: cid, nom: match[2], thumbnail: "", subscriberCount: 0, description: "" });
    }
    if (results.length >= maxResults) break;
  }

  // Also try the simpler regex for channel IDs
  if (results.length < maxResults) {
    const altRegex = /"channelId"\s*:\s*"(UC[\w-]{22})"/g;
    while ((match = altRegex.exec(html)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        results.push({ channelId: match[1], nom: "", thumbnail: "", subscriberCount: 0, description: "" });
      }
      if (results.length >= maxResults) break;
    }
  }

  // Enrich each result: get name, thumbnail and subscriber count from channel page (FREE scraping)
  await runWithLimit(results, async (ch) => {
    try {
      const html = await fetchPageText(`https://www.youtube.com/channel/${ch.channelId}`);
      if (html) {
        const data = extractFromHTML(html);
        if (data.name) ch.nom = data.name;
        if (data.thumbnail) ch.thumbnail = data.thumbnail;
        if (data.subscriberCount) ch.subscriberCount = data.subscriberCount;
        if (data.description) ch.description = data.description;
      }
    } catch { /* keep going */ }

    // Fallback: try RSS feed if we still don't have a name
    if (!ch.nom) {
      try {
        const xml = await fetchPageText(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.channelId}`);
        if (xml) {
          const titleMatch = xml.match(/<title>([^<]+)<\/title>/);
          ch.nom = decodeHtmlEntities(titleMatch?.[1] || ch.channelId);
          const thumbMatch = xml.match(/<media:thumbnail url="([^"]+)"/);
          if (!ch.thumbnail) ch.thumbnail = thumbMatch?.[1] || "";
        }
      } catch { /* keep going */ }
    }
  }, 3, 300);

  return results.filter((ch) => ch.nom);
}

// --- Video URL → Channel resolver (FREE, zero API cost) ---

function extractVideoIdFromUrl(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/v\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  const fallback = url.split("/").pop()?.split("?")[0];
  return fallback?.length === 11 ? fallback : null;
}

export async function resolveFromVideoUrl(videoUrl) {
  const videoId = extractVideoIdFromUrl(videoUrl);
  if (!videoId) return null;

  try {
    const html = await fetchPageText(`https://www.youtube.com/watch?v=${videoId}`);
    if (!html) return null;

    // Extract channel info from the video page
    const channelIdMatch = html.match(/"channelId"\s*:\s*"(UC[\w-]{22})"/);
    if (!channelIdMatch) return null;
    const channelId = channelIdMatch[1];

    // Try to get channel name from the video page
    const nameMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    const name = nameMatch ? decodeHtmlEntities(nameMatch[1]) : "";

    // Try to get channel thumbnail
    const thumbMatch = html.match(/"avatar"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
    const thumbnail = thumbMatch?.[1] || "";

    // Get subscriber count if available
    const subsMatch = html.match(/"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+)"/);
    let subscriberCount = 0;
    if (subsMatch?.[1]) {
      const numMatch = subsMatch[1].replace(/,/g, ".").match(/([\d.]+)\s*(K|M|Mi|abonn)/i);
      if (numMatch) {
        let n = parseFloat(numMatch[1]);
        if (/K|Ki/i.test(numMatch[2])) n *= 1000;
        else if (/M|Mi/i.test(numMatch[2])) n *= 1000000;
        subscriberCount = Math.round(n);
      }
    }

    // Also get the video title for context
    const titleMatch = html.match(/"title"\s*:\s*"([^"]+)"/);
    const videoTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : "";

    // If name extraction failed, try RSS feed
    let finalName = name;
    if (!finalName) {
      try {
        const xml = await fetchPageText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
        if (xml) {
          const rssTitle = xml.match(/<title>([^<]+)<\/title>/);
          finalName = decodeHtmlEntities(rssTitle?.[1] || "");
        }
      } catch {}
    }

    return {
      channelId,
      nom: finalName || channelId,
      thumbnail,
      subscriberCount,
      videoId,
      videoTitle,
    };
  } catch (err) {
    console.error(`[Resolve] Failed to resolve video URL: ${err.message}`);
    return null;
  }
}

// --- Related channels scraping (FREE, zero API cost) ---

export async function scrapeRelatedChannels(channelId, { signal = null } = {}) {
  try {
    // Fetch a video from this channel to get its recommendations
    const html = await fetchPageText(`https://www.youtube.com/channel/${channelId}/videos`, { signal });
    if (!html) return [];

    // Find the first video ID from this channel
    const videoMatch = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
    if (!videoMatch) return [];

    const videoId = videoMatch[1];

    // Scrape the video page for sidebar recommendations
    const videoHtml = await fetchPageText(`https://www.youtube.com/watch?v=${videoId}`, { signal });
    if (!videoHtml) return [];

    const data = extractYtInitialData(videoHtml);
    if (!data) return [];

    const relatedChannels = [];
    const seenChIds = new Set();

    // Extract from lockupViewModels in secondaryResults
    try {
      const results = data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
      for (const section of results) {
        const items = section?.itemSectionRenderer?.contents || [];
        for (const item of items) {
          const lvm = item.lockupViewModel;
          if (!lvm) continue;

          // Extract channel info from the avatar's browse endpoint
          const avatar = lvm?.metadata?.lockupMetadataViewModel?.image?.decoratedAvatarViewModel;
          if (!avatar) continue;

          const browseEndpoint = avatar?.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint;
          const chId = browseEndpoint?.browseId;
          if (!chId || chId === channelId || seenChIds.has(chId)) continue;
          seenChIds.add(chId);

          const name = (avatar?.a11yLabel || "").replace(/^Go to channel /, "");
          const thumbnail = avatar?.avatar?.avatarViewModel?.image?.sources?.[0]?.url || "";

          relatedChannels.push({ channelId: chId, nom: name, thumbnail, subscriberCount: 0 });
        }
      }
    } catch {}

    return relatedChannels.slice(0, 20);
  } catch (err) {
    console.error(`[Scrape] Failed to get related channels for ${channelId}: ${err.message}`);
    return [];
  }
}

// --- French language detection ---

function isLikelyFrench(html) {
  if (!html) return false;
  const texts = [];

  // Channel description from ytInitialData or meta
  const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (metaDesc) texts.push(metaDesc[1]);

  const dataMatch = html.match(/var ytInitialData = ({[\s\S]*?});<\/script>/);
  if (dataMatch) {
    try {
      const data = JSON.parse(dataMatch[1]);
      const metadata = data?.metadata?.channelMetadataRenderer;
      if (metadata?.description) texts.push(metadata.description);
      if (metadata?.title) texts.push(metadata.title);
      // Try to get video tab titles
      const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      for (const tab of tabs) {
        const contents = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const section of contents) {
          const items = section?.itemSectionRenderer?.contents || [];
          for (const item of items) {
            const gridItems = item?.shelfRenderer?.content?.expandedShelfContentsRenderer?.items ||
                             item?.gridRenderer?.items || [];
            for (const gi of gridItems) {
              const r = gi.gridVideoRenderer || gi.richItemRenderer?.content?.videoRenderer;
              if (r?.title?.runs) {
                texts.push(r.title.runs.map((run) => run.text).join(""));
              } else if (r?.title?.simpleText) {
                texts.push(r.title.simpleText);
              }
            }
          }
        }
      }
    } catch {}
  }

  if (texts.length === 0) return false;

  const frenchAccents = /[éèêëàâîïôùûüçœÉÈÊËÀÂÎÏÔÙÛÜÇŒ]/;
  const frenchWords = /\b(le|la|les|des|pour|dans|avec|sur|une|est|sont|pas|plus|comment|pourquoi|tous|toutes?|vidéo|abonnés?|français|chaîne|histoire|monde|faire|tous|cette|entre|sans|chez|deux|bien|très|aussi|mais|donc|donc|quand|alors|ainsi|peut|fait|faire|voir|savoir|devoir|vouloir|pouvoir|venir|aller|parler|dire|avoir|être)\b/i;

  let frenchScore = 0;
  let totalScore = 0;

  for (const text of texts) {
    totalScore++;
    if (frenchAccents.test(text)) frenchScore += 2;
    const wordMatches = text.match(frenchWords);
    if (wordMatches) frenchScore += wordMatches.length;
  }

  return frenchScore >= Math.max(totalScore * 0.3, 1);
}

// --- Related channel discovery from validated channels ---

export async function discoverRelatedFromValidated(onProgress, onResult, { passes = 1, statuses = ['validated'], signal = null, pauseRef = null } = {}) {
  const normalizedStatuses = [...new Set((Array.isArray(statuses) ? statuses : [])
    .filter((status) => ['pending', 'validated', 'rejected'].includes(status)))];
  if (normalizedStatuses.length === 0) return [];
  const normalizedPasses = Math.max(1, Math.min(10, Number(passes) || 1));
  // Build parameterized IN clause for the list of statuses
  const placeholders = normalizedStatuses.map(() => '?').join(', ');
  const query = `SELECT channel_id, nom FROM channels WHERE status IN (${placeholders})`;
  const baseSeeds = db.query(query).all(...normalizedStatuses);
  // Google's recommendations vary between fetches, so scraping each channel
  // `passes` times surfaces more candidates within a single run.
  const validated = [];
  for (let i = 0; i < normalizedPasses; i++) validated.push(...baseSeeds);
  // Fisher-Yates shuffle so exploration order is random on every run
  for (let i = validated.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [validated[i], validated[j]] = [validated[j], validated[i]];
  }
  const allExisting = db.query(`SELECT channel_id FROM channels`).all();
  const blacklisted = new Set(stmts.getBlacklistedChannelIds.all().map((r) => r.channel_id));
  const existingIds = new Set(allExisting.map((ch) => ch.channel_id));
  const excludedIds = new Set([...existingIds, ...blacklisted]);
  const seen = new Set();
  const results = [];
  let completed = 0;

  // Helper: wait while paused, checking the signal
  const waitWhilePaused = async () => {
    while (pauseRef?.paused && !signal?.aborted) {
      await new Promise(r => setTimeout(r, 500));
    }
  };

  await runWithLimit(validated, async (ch) => {
    // Check abort signal before processing
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Wait if paused
    await waitWhilePaused();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    onProgress?.(completed, validated.length, ch.nom, "running");

    try {
      const related = await scrapeRelatedChannels(ch.channel_id, { signal });
      for (const rc of related) {
        if (seen.has(rc.channelId) || excludedIds.has(rc.channelId)) continue;
        seen.add(rc.channelId);

        // Enrich and check if French
        try {
          const html = await fetchPageText(`https://www.youtube.com/channel/${rc.channelId}`, { signal });
          if (html) {
            const data = extractFromHTML(html);
            rc.nom = data.name || rc.nom;
            rc.thumbnail = data.thumbnail || rc.thumbnail;
            rc.subscriberCount = data.subscriberCount;
            rc.description = data.description || "";
            if (!isLikelyFrench(html)) continue;
          }
        } catch (err) {
          if (signal?.aborted) throw err;
          continue;
        }

        rc.source_channel = ch.nom;

        // Insert as pending before notifying the caller so the UI never gets ahead of the database.
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        stmts.insertChannel.run({
          $nom: rc.nom || rc.channelId,
          $channel_id: rc.channelId,
          $subscriber_count: rc.subscriberCount || 0,
          $last_video_date: null,
          $thumbnail: rc.thumbnail || "",
          $description: rc.description || "",
        });
        results.push(rc);
        onResult?.(rc);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error(`[Related] Failed for ${ch.nom}: ${err.message}`);
    } finally {
      completed++;
      onProgress?.(completed, validated.length, ch.nom, "done");
    }
  }, 5, 500, { signal });

  console.log(`[Related] Found ${results.length} new French channels from ${validated.length} validated channels`);
  return results;
}
