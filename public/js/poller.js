// Generic async job poller — used by scoring, related discovery, and refresh stats.
// Starts a job via POST, then polls a status endpoint until done/error/cancelled.
//
// `statusUrl` can be a string containing {jobId}/{cursor}, or a function receiving
// `{ jobId, state }`. The mutable state object is updated with `data.next`,
// which makes incremental result endpoints safe from duplicate polling.

function waitFor(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason || new Error("Operation cancelled"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason || new Error("Operation cancelled"));
    };
    const timer = setTimeout(() => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollJob({
  startUrl,
  startBody,
  statusUrl,
  onProgress,
  interval = FRONTEND_DELAYS.POLL_INTERVAL_MS,
  deadline = FRONTEND_DELAYS.POLL_DEADLINE_MS,
  maxFailures = FRONTEND_LIMITS.POLL_MAX_FAILURES,
  signal,
}) {
  if (signal?.aborted) throw signal.reason || new Error("Operation cancelled");

  const startOpts = { method: "POST", timeout: 30000, signal };
  if (startBody) startOpts.body = JSON.stringify(startBody);

  let started;
  try {
    started = await api(startUrl, startOpts);
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    if (!/in progress|409/i.test(err.message)) throw err;
    await waitFor(FRONTEND_DELAYS.POLL_RETRY_MS, signal);
    started = await api(startUrl, startOpts);
  }

  const jobId = started.jobId || "";
  if (!jobId) throw new Error("Impossible d'identifier le job");

  const state = { cursor: 0 };
  const pollingDeadline = Date.now() + deadline;
  let failures = 0;

  while (Date.now() < pollingDeadline) {
    if (signal?.aborted) throw signal.reason || new Error("Operation cancelled");
    await waitFor(interval, signal);

    let data;
    try {
      const url = typeof statusUrl === "function"
        ? statusUrl({ jobId, state })
        : statusUrl
          .replace("{jobId}", encodeURIComponent(jobId))
          .replace("{cursor}", encodeURIComponent(state.cursor));
      data = await api(url, { timeout: 30000, signal });
      failures = 0;
    } catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      failures++;
      if (failures >= maxFailures) throw err;
      continue;
    }

    if (Number.isInteger(data?.next) && data.next >= state.cursor) {
      state.cursor = data.next;
    }
    onProgress?.(data);

    if (data.status === JOB_STATUSES.DONE || data.status === JOB_STATUSES.CANCELLED) return data;
    if (data.status === JOB_STATUSES.ERROR || data.status === JOB_STATUSES.INTERRUPTED) {
      throw new Error(data.error || "Le job a été interrompu par le serveur");
    }
  }

  throw new Error("Le suivi a expiré après deux heures, mais le job peut continuer sur le serveur.");
}
