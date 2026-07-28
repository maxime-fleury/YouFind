import { refreshAllChannels } from "./rss.js";
import { discoverFromTopic } from "./youtube-api.js";
import { stmts } from "./db.js";
import { runWithLimit } from "./utils.js";
import { runBackup } from "./backup.js";

const INTERVALS = {
  rss: 24 * 60 * 60 * 1000,
  discover: 3 * 24 * 60 * 60 * 1000,
};

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

export { runRSSRefresh, runDiscovery, INTERVALS, startCron };

function startCron() {
  console.log("[Cron] Starting scheduled tasks...");
  console.log(`[Cron] RSS refresh every ${INTERVALS.rss / 3600000}h`);
  console.log(`[Cron] Discovery every ${INTERVALS.discover / 86400000}d`);
  console.log("[Cron] DB backup daily at midnight-ish");

  setInterval(async () => {
    try { await runRSSRefresh(); } catch (e) { console.error("[Cron] RSS error:", e.message); }
  }, INTERVALS.rss);

  setInterval(async () => {
    try { await runDiscovery(); } catch (e) { console.error("[Cron] Discovery error:", e.message); }
  }, INTERVALS.discover);

  setInterval(async () => {
    try { await runBackup(); } catch (e) { console.error("[Cron] Backup error:", e.message); }
  }, 24 * 60 * 60 * 1000);

  // Run backup 30s after startup (don't delay the first real intervals)
  setTimeout(() => runBackup(), 30_000);

  console.log("[Cron] All tasks scheduled.");
}
