import { describe, expect, test } from "bun:test";
import { isYoutubeChannelId, parsePositiveId, readJsonBody } from "../src/http-helpers.js";

describe("HTTP helpers", () => {
  test("accepts JSON objects and rejects malformed or non-object bodies", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ topic: "history" }),
    });
    await expect(readJsonBody(request, 1000)).resolves.toEqual({ topic: "history" });

    const malformed = new Request("http://localhost", { method: "POST", body: "{bad" });
    await expect(readJsonBody(malformed, 1000)).rejects.toMatchObject({ status: 400 });

    const array = new Request("http://localhost", { method: "POST", body: "[]" });
    await expect(readJsonBody(array, 1000)).rejects.toMatchObject({ status: 400 });
  });

  test("enforces body size and validates route identifiers", async () => {
    const oversized = new Request("http://localhost", { method: "POST", body: "123456" });
    await expect(readJsonBody(oversized, 5)).rejects.toMatchObject({ status: 413 });

    expect(parsePositiveId("42")).toBe(42);
    expect(parsePositiveId("0")).toBeNull();
    expect(parsePositiveId("42.5")).toBeNull();
    expect(isYoutubeChannelId("UC1234567890123456789012")).toBe(true);
    expect(isYoutubeChannelId("not-a-channel")).toBe(false);
  });
});
