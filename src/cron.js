import { refreshAllChannels } from "./rss.js";
import { discoverFromTopic } from "./youtube-api.js";
import { stmts } from "./db.js";
import { runWithLimit } from "./utils.js";
import { runBackup } from "./backup.js";

const INTERVALS = {
  rss: 24 * 60 * 60 * 1000,
  discover: 3 * 24 * 60 * 60 * 1000,
};

// Track when the RSS refresh last ran and when the next automatic run is due,
// so the UI can show "prochain refresh dans Xh" / "dernier il y a Xh".
const taskState = {
  rss: { lastRunAt: null, nextRunAt: null },
};

function getRSSInfo() {
  return {
    lastRunAt: taskState.rss.lastRunAt,
    nextRunAt: taskState.rss.nextRunAt,
    intervalMs: INTERVALS.rss,
  };
}

// Manual refreshes (triggered from the UI) share the same "last run" clock.
function markRSSLastRun(ts = Date.now()) {
  taskState.rss.lastRunAt = ts;
}

async function runRSSRefresh() {
  console.log("[Cron] Starting RSS refresh...");
  const results = await refreshAllChannels();
  console.log(`[Cron] RSS refresh done: ${results.length} channels updated`);
  return results;
}

async function runDiscovery() {
  const topics = stmts.getAllTopics.all();
  if (topics.length === 0) {
    console.log("[Cron] No topics defined, skipping discovery");
    return [];
  }

  console.log("[Cron] Starting discovery...");
  const allResults = [];

  await runWithLimit(topics, async (topic) => {
    console.log(`[Cron] Discovering for topic: "${topic.nom}"`);
    const results = await discoverFromTopic(topic.nom);
    allResults.push({ topic: topic.nom, found: results.channels?.length || 0 });
  }, 2, 2000);

  console.log(`[Cron] Discovery done for ${topics.length} topics`);
  return allResults;
}

if (process.argv[1] && process.argv[1].endsWith("cron.js")) {
  console.log("[Cron] Manual run starting...");

  await runRSSRefresh();
  await runDiscovery();

  console.log("[Cron] Manual run complete.");
  process.exit(0);
}

export { runRSSRefresh, runDiscovery, INTERVALS, startCron, getRSSInfo, markRSSLastRun };

function scheduleTask(name, task, intervalMs, initialDelayMs = intervalMs) {
  const scheduleNext = (delay) => {
    if (name === "RSS") taskState.rss.nextRunAt = Date.now() + delay;
    setTimeout(async () => {
      try {
        if (name === "RSS") taskState.rss.lastRunAt = Date.now();
        await task();
      } catch (e) {
        console.error(`[Cron] ${name} error:`, e.message);
      } finally {
        // Schedule after completion so slow jobs can never overlap themselves.
        scheduleNext(intervalMs);
      }
    }, delay);
  };
  scheduleNext(initialDelayMs);
}

function startCron() {
  console.log("[Cron] Starting scheduled tasks...");
  console.log(`[Cron] RSS refresh every ${INTERVALS.rss / 3600000}h`);
  console.log(`[Cron] Discovery every ${INTERVALS.discover / 86400000}d`);
  console.log("[Cron] DB backup daily at midnight-ish");

  scheduleTask("RSS", runRSSRefresh, INTERVALS.rss);
  scheduleTask("Discovery", runDiscovery, INTERVALS.discover);
  scheduleTask("Backup", runBackup, 24 * 60 * 60 * 1000, 30_000);

  console.log("[Cron] All tasks scheduled.");
}
