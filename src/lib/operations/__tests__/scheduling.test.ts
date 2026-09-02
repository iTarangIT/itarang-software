import { describe, expect, it, vi } from "vitest";

import { isDue, withTimeout } from "../scheduling";

/**
 * The runner's two pieces of pure logic. Everything else in runner.ts talks to
 * the database and is verified against a real Postgres instead.
 */

describe("isDue", () => {
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const FIVE_MIN = 5 * 60_000;

  it("is due when it has never run", () => {
    expect(isDue(FIVE_MIN, undefined, now)).toBe(true);
    expect(isDue(FIVE_MIN, null, now)).toBe(true);
  });

  it("is not due before the interval has elapsed", () => {
    expect(isDue(FIVE_MIN, new Date(now - 60_000), now)).toBe(false);
  });

  it("is due exactly on the interval boundary", () => {
    // `>=`, not `>`. With a strict comparison a 60s tick against a 60s interval
    // fires only every other tick, halving every collector's real cadence.
    expect(isDue(FIVE_MIN, new Date(now - FIVE_MIN), now)).toBe(true);
  });

  it("measures from the START, so a slow collector does not drift", () => {
    // A collector that starts at 12:00 and takes 90s: at 12:05 it is due again,
    // because "due" is 5 minutes after it STARTED. Measuring from the finish
    // would push it to 12:06:30, then 12:08, and so on until the cadence is
    // unrecognisable.
    const startedAt = new Date(now - FIVE_MIN);
    expect(isDue(FIVE_MIN, startedAt, now)).toBe(true);
  });
});

describe("withTimeout", () => {
  it("passes through a value that resolves in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "c")).resolves.toBe("ok");
  });

  it("passes through a rejection unchanged", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("collector blew up")), 1000, "c"),
    ).rejects.toThrow("collector blew up");
  });

  it("rejects a promise that never settles, naming the collector", async () => {
    vi.useFakeTimers();
    try {
      const hung = withTimeout(new Promise<never>(() => {}), 10_000, "vendor.elevenlabs");
      const assertion = expect(hung).rejects.toThrow(
        "vendor.elevenlabs timed out after 10000ms",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer once the promise settles", async () => {
    // A tick's worth of orphaned timers would keep the event loop busy long
    // after the work finished — and the ticker unrefs its own interval
    // precisely so the process can exit when idle.
    vi.useFakeTimers();
    try {
      const clear = vi.spyOn(globalThis, "clearTimeout");
      await withTimeout(Promise.resolve(1), 10_000, "c");
      expect(clear).toHaveBeenCalled();
      clear.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
