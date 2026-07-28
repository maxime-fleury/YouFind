export async function runWithLimit(items, fn, limit, delayMs = 0) {
  if (!items || items.length === 0) return [];
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
      if (delayMs > 0 && index < items.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
