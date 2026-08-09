import { describe, expect, test } from "bun:test";
import { runWithLimit } from "../src/utils.js";
import { createJobId, createProgressTracker, resetProgressTracker } from "../src/job-utils.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("job utilities", () => {
  test("creates unique-looking IDs and resets progress without losing custom fields", () => {
    const tracker = createProgressTracker({ jobId: "old", custom: true });
    tracker.completed = 4;
    resetProgressTracker(tracker, { jobId: createJobId(), custom: false });

    expect(tracker.status).toBe("running");
    expect(tracker.completed).toBe(0);
    expect(tracker.custom).toBe(false);
    expect(tracker.jobId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe("runWithLimit", () => {
  test("preserves input order while limiting concurrency", async () => {
    let active = 0;
    let peak = 0;
    const result = await runWithLimit([1, 2, 3, 4, 5], async (value) => {
      active++;
      peak = Math.max(peak, active);
      await wait(2);
      active--;
      return value * 2;
    }, 2);

    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("rejects invalid concurrency instead of silently doing nothing", async () => {
    await expect(runWithLimit([1], async (value) => value, 0)).rejects.toThrow("limit");
  });

  test("stops and waits for workers after cancellation", async () => {
    const controller = new AbortController();
    let completed = 0;
    const promise = runWithLimit([1, 2, 3, 4], async () => {
      await wait(10);
      completed++;
    }, 2, 0, { signal: controller.signal });

    setTimeout(() => controller.abort(), 2);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(completed).toBeLessThan(4);
  });
});
