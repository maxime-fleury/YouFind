// Shared browser API client.
// Keeps timeout and caller cancellation independent while ensuring both are cleaned up.
async function api(path, opts = {}) {
  const { timeout: timeoutMs, signal: userSignal, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FRONTEND_DELAYS.API_TIMEOUT_MS);
  const onUserAbort = userSignal ? () => controller.abort(userSignal.reason) : null;

  if (userSignal) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else userSignal.addEventListener("abort", onUserAbort, { once: true });
  }

  try {
    const res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...fetchOpts,
    });
    if (!res.ok) {
      const text = await res.text();
      let errorMessage;
      try { errorMessage = JSON.parse(text).error || text; } catch { errorMessage = text; }
      if (res.status === 422) {
        console.error(`[API] 422 Unprocessable Entity on ${path}:`, text);
        throw new Error("Requete invalide (422). Verifiez la cle API ou les parametres.");
      }
      throw new Error(errorMessage || `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  } finally {
    clearTimeout(timer);
    if (userSignal && onUserAbort) userSignal.removeEventListener("abort", onUserAbort);
  }
}
