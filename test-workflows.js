const BASE = "http://127.0.0.1:3002";

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const topicName = `TestTopic-${Date.now()}`;
let topicId = null;

async function run() {
  console.log("--- stats ---");
  const stats = await api("/api/stats");
  console.log(stats.data);
  assert(stats.status === 200, "stats failed");

  console.log("--- create topic ---");
  const topicRes = await api("/api/topics", {
    method: "POST",
    body: JSON.stringify({ nom: topicName, description: "workflow test" }),
  });
  console.log(topicRes.data);
  assert(topicRes.status === 201 || topicRes.status === 200, "topic create failed");
  topicId = topicRes.data.id;

  console.log("--- add channel ---");
  const channelId = "UCBR8-60-B2-gCBmo3Zv6s_g";
  const addRes = await api("/api/channels", {
    method: "POST",
    body: JSON.stringify({ nom: "YouTube Test", channel_id: channelId }),
  });
  console.log(addRes.data);
  assert(addRes.status === 201, `add channel failed: ${JSON.stringify(addRes.data)}`);
  const channelDbId = addRes.data.id;

  console.log("--- list pending channels ---");
  const listRes = await api("/api/channels?status=pending");
  assert(listRes.status === 200, "list channels failed");
  const found = listRes.data.find((c) => c.channel_id === channelId);
  assert(found, "added channel not found in pending list");

  console.log("--- reject channel ---");
  const rejectRes = await api(`/api/channels/${channelDbId}/reject`, {
    method: "POST",
    body: JSON.stringify({ raison: "test blacklist" }),
  });
  console.log(rejectRes.data);
  assert(rejectRes.status === 200, "reject failed");

  console.log("--- verify rejected channel gone ---");
  const afterReject = await api("/api/channels?status=pending");
  assert(!afterReject.data.some((c) => c.channel_id === channelId), "rejected channel still pending");

  console.log("--- import same channel should skip (blacklist) ---");
  const importRes = await api("/api/channels/import", {
    method: "POST",
    body: JSON.stringify({ text: `https://www.youtube.com/channel/${channelId}` }),
  });
  console.log(importRes.data);
  assert(importRes.status === 200, "import failed");
  assert(importRes.data.added === 0, "blacklisted channel was re-added by import");
  assert(importRes.data.skipped === 1, `expected skip count 1, got ${importRes.data.skipped}`);

  console.log("--- discover (blacklist respected) ---");
  const discoverRes = await api("/api/discover", {
    method: "POST",
    body: JSON.stringify({ topic: topicName, count: 5, offset: 0 }),
  });
  console.log(discoverRes.data);
  assert(discoverRes.status === 200, "discover failed");
  assert(Array.isArray(discoverRes.data.channels), "discover response missing channels array");
  assert(!discoverRes.data.channels.some((c) => c.channelId === channelId), "blacklisted channel resurfaced in discovery");

  console.log("--- videos ---");
  const videosRes = await api("/api/videos?limit=10&sort=newest");
  assert(videosRes.status === 200, "videos failed");
  assert(Array.isArray(videosRes.data), "videos response is not an array");

  console.log("--- videos invalid sort rejected ---");
  const badSortRes = await api("/api/videos?limit=10&sort=invalid");
  assert(badSortRes.status === 400, "invalid sort was accepted");

  console.log("--- settings ---");
  const settings = await api("/api/settings");
  console.log(Object.keys(settings.data));
  assert(settings.status === 200, "settings failed");

  console.log("--- llm status ---");
  const llmRes = await api("/api/llm-status");
  console.log(llmRes.data);
  assert(llmRes.status === 200, "llm status failed");

  console.log("--- dashboard ---");
  const dash = await api("/api/dashboard");
  console.log(Object.keys(dash.data));
  assert(dash.status === 200, "dashboard failed");

  console.log("--- cleanup topic ---");
  const deleteRes = await api(`/api/topics?id=${topicId}`, { method: "DELETE" });
  assert(deleteRes.status === 200, "topic cleanup failed");

  console.log("\n✅ All workflow checks passed");
}

run().catch((err) => {
  console.error("\n❌ Workflow test failed:", err.message);
  process.exit(1);
});
