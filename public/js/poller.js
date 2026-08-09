// Generic async job poller — used by scoring, related discovery, and refresh stats.
// Starts a job via POST, then polls a status endpoint until done/error/cancelled.
//
// Options:
//   startUrl    — POST endpoint to start the job
//   startBody   — optional body for the start request
//   statusUrl   — GET endpoint to poll (receives {jobId} placeholder, e.g. "/status?job={jobId}")
//   onProgress  — called with the status data on each poll
//   interval    — poll interval in ms (default 1000)
//   deadline    — max poll duration in ms (default 2 hours)
//   maxFailures — max consecutive poll failures before throwing (default 10)
//
// Returns the final status data.

async function pollJob({ startUrl, startBody, statusUrl, onProgress, interval = 1000, deadline = 2 * 60 * 60 * 1000, maxFailures = 10 }) {
  // Start the job
  const startOpts = { method: "POST", timeout: 30000 };
  if (startBody) startOpts.body = JSON.stringify(startBody);

  let started;
  try {
    started = await api(startUrl, startOpts);
  } catch (err) {
    if (!/in progress|409/i.test(err.message)) throw err;
    await new Promise(r => setTimeout(r, 2000));
    started = await api(startUrl, startOpts);
  }

  const jobId = started.jobId || "";
  if (!jobId) throw new Error("Impossible d'identifier le job");

  // Poll until done
  const pollingDeadline = Date.now() + deadline;
  let failures = 0;

  while (Date.now() < pollingDeadline) {
    await new Promise(r => setTimeout(r, interval));
    let data;
    try {
      data = await api(statusUrl.replace("{jobId}", encodeURIComponent(jobId)), { timeout: 30000 });
      failures = 0;
    } catch (err) {
      failures++;
      if (failures >= maxFailures) throw err;
      continue;
    }

    if (onProgress) onProgress(data);

    if (data.status === "done" || data.status === "cancelled") return data;
    if (data.status === "error") throw new Error(data.error || "Erreur pendant le job");
  }

  throw new Error("Le suivi a expiré après deux heures, mais le job peut continuer sur le serveur.");
}
