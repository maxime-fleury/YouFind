function abortError() {
  return typeof DOMException === "function"
    ? new DOMException("The operation was aborted", "AbortError")
    : Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || abortError();
}

async function delay(ms, signal) {
  if (ms <= 0) return;
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    let settled = false;
    let timer;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason || abortError());
    };
    timer = setTimeout(() => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run work with bounded concurrency. Workers stop together on the first error
 * or when the optional AbortSignal is cancelled; all workers are awaited before
 * the promise settles so callers never observe late writes after cancellation.
 */
export async function runWithLimit(items, fn, limit, delayMs = 0, { signal = null } = {}) {
  if (!items || items.length === 0) return [];
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError("delayMs must be a non-negative number");
  }

  const results = new Array(items.length);
  let index = 0;
  let stopped = false;

  async function worker() {
    while (!stopped) {
      throwIfAborted(signal);
      const i = index++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        stopped = true;
        throw error;
      }
      if (delayMs > 0 && index < items.length) await delay(delayMs, signal);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}
