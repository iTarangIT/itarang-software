// ID 227 — the tick bookkeeping helpers.
import { describe, expect, it } from "vitest";

import { failureFromLog, jobRunName, shouldWrite } from "@/lib/runtime/jobRuns";

describe("failureFromLog", () => {
  it("takes a ticker's own failure line", () => {
    expect(failureFromLog(["[instrumentation:zoho-sync] tick failed:", "timeout"])).toBe(
      "[instrumentation:zoho-sync] tick failed: timeout",
    );
    expect(failureFromLog(["[instrumentation:buyback-agreements] sync failed:", new Error("boom")])).toBe(
      "[instrumentation:buyback-agreements] sync failed: boom",
    );
    expect(failureFromLog(["[instrumentation:buyback-price-nudge] failed:", "x"])).toBe(
      "[instrumentation:buyback-price-nudge] failed: x",
    );
  });

  it("ignores lines from the work itself and non-failure lines", () => {
    expect(failureFromLog(["[backfill-cost] bolna abc failed:", "x"])).toBeNull();
    expect(failureFromLog(["[instrumentation:digests] sent 3"])).toBeNull();
    expect(failureFromLog([new Error("x")])).toBeNull();
    expect(failureFromLog([])).toBeNull();
  });

  it("caps a long message", () => {
    const msg = failureFromLog(["[instrumentation:x] tick failed:", "y".repeat(2000)]);
    expect(msg!.length).toBeLessThanOrEqual(500);
  });
});

describe("shouldWrite", () => {
  it("writes the first run, every failure, and otherwise once a minute", () => {
    expect(shouldWrite(undefined, 1_000, false)).toBe(true);
    expect(shouldWrite(0, 30_000, false)).toBe(false);
    expect(shouldWrite(0, 30_000, true)).toBe(true);
    expect(shouldWrite(0, 60_000, false)).toBe(true);
  });
});

describe("jobRunName", () => {
  it("is the job name, with the part for multi-tick jobs", () => {
    expect(jobRunName("dialer", "poll")).toBe("dialer:poll");
    expect(jobRunName("zoho-sync")).toBe("zoho-sync");
    expect(jobRunName(undefined)).toBe("unnamed");
  });
});
