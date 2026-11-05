// ID 227 — every scheduled job is accounted for: each vercel.json cron is run
// by a ticker, covered by another job, or deliberately off; each ticker started
// in instrumentation.ts is listed. A new cron added only to vercel.json (which
// never fires on the PM2 servers) fails here instead of silently never running.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SCHEDULED_JOBS,
  jobHealth,
  listedCronPaths,
  scheduleText,
  tickerJobNames,
} from "@/lib/operations/scheduledJobs";

const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string }> };
const instrumentation = readFileSync("src/instrumentation.ts", "utf8");
const tickers = readFileSync("src/instrumentation-node.ts", "utf8");

describe("ID 227 scheduled job list", () => {
  it("lists every vercel.json cron path", () => {
    const listed = listedCronPaths();
    const missing = vercel.crons.map((c) => c.path).filter((p) => !listed.has(p));
    expect(missing).toEqual([]);
  });

  it("lists no cron path that vercel.json does not have", () => {
    const inVercel = new Set(vercel.crons.map((c) => c.path));
    const extra = [...listedCronPaths()].filter((p) => !inVercel.has(p));
    expect(extra).toEqual([]);
  });

  it("lists every job instrumentation.ts starts", () => {
    const started = [...instrumentation.matchAll(/runAsJob\("([^"]+)"/g)].map((m) => m[1]);
    expect(started.length).toBeGreaterThan(30);
    const names = tickerJobNames();
    const missing = started.filter((job) => !names.some((n) => n === job || n.startsWith(`${job}:`)));
    expect(missing).toEqual([]);
  });

  it("names the parts of multi-tick jobs exactly as the tickers do", () => {
    for (const part of ["poll", "watchdog", "window", "agreements", "dedup", "nudge", "daily"]) {
      expect(tickers).toContain(`"${part}")`);
    }
  });

  it("every ticker timer records its run", () => {
    const timers = [...tickers.matchAll(/set(?:Timeout|Interval)\(([^\n]{0,12})/g)].map((m) => m[1]);
    // The dialer kickoff is a closure that calls trackTick itself.
    const untracked = timers.filter((t) => !t.startsWith("trackTick(") && !t.startsWith("() =>"));
    expect(untracked).toEqual([]);
  });

  it("gives every job that is off a reason and who decides", () => {
    for (const j of SCHEDULED_JOBS) {
      if (j.runner.kind === "off") {
        expect(j.runner.reason.length).toBeGreaterThan(20);
        expect(j.runner.decision).toMatch(/Kartik/);
      }
    }
  });

  it("keeps the money-moving jobs off", () => {
    const off = SCHEDULED_JOBS.filter((j) => j.runner.kind === "off").map((j) => j.id).sort();
    expect(off).toEqual([
      "bolna-call-scheduler",
      "elevenlabs-call-scheduler",
      "emi-autodebit",
      "nbfc-origination-maintenance",
    ]);
  });

  it("has unique ids and job names", () => {
    const ids = SCHEDULED_JOBS.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = tickerJobNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("jobHealth", () => {
  const now = new Date("2026-11-05T10:00:00Z");
  const ticker = { kind: "ticker" as const, job: "x", everyMs: 15 * 60_000 };

  it("is never without a run, ok when recent, late when overdue, failed on failure", () => {
    expect(jobHealth(ticker, null, now)).toBe("never");
    expect(jobHealth(ticker, { finishedAt: new Date("2026-11-05T09:50:00Z"), status: "ok" }, now)).toBe("ok");
    expect(jobHealth(ticker, { finishedAt: new Date("2026-11-05T09:00:00Z"), status: "ok" }, now)).toBe("late");
    expect(jobHealth(ticker, { finishedAt: new Date("2026-11-05T09:55:00Z"), status: "failed" }, now)).toBe("failed");
  });

  it("marks a daily job late when its time passed today with no run", () => {
    const daily = { ...ticker, everyMs: 5 * 60_000, dailyKind: "d", dailyAt: "09:30 IST" };
    const last = { finishedAt: new Date("2026-11-05T09:58:00Z"), status: "ok" };
    expect(jobHealth(daily, last, now, { istDate: "2026-11-04", status: "sent", dueToday: true, todayIst: "2026-11-05" })).toBe("late");
    expect(jobHealth(daily, last, now, { istDate: "2026-11-05", status: "sent", dueToday: true, todayIst: "2026-11-05" })).toBe("ok");
    expect(jobHealth(daily, last, now, { istDate: "2026-11-04", status: "sent", dueToday: false, todayIst: "2026-11-05" })).toBe("ok");
    expect(jobHealth(daily, last, now, { istDate: "2026-11-05", status: "failed", dueToday: true, todayIst: "2026-11-05" })).toBe("failed");
  });

  it("reports off and covered jobs as such", () => {
    expect(jobHealth({ kind: "off", reason: "r", decision: "d" }, null, now)).toBe("off");
    expect(jobHealth({ kind: "covered", by: "x", note: "n" }, null, now)).toBe("covered");
  });
});

describe("scheduleText", () => {
  it("says how often in plain words", () => {
    expect(scheduleText({ kind: "ticker", job: "a", everyMs: 30_000 })).toBe("every 30 s");
    expect(scheduleText({ kind: "ticker", job: "a", everyMs: 15 * 60_000 })).toBe("every 15 min");
    expect(scheduleText({ kind: "ticker", job: "a", everyMs: 60 * 60_000 })).toBe("hourly");
    expect(scheduleText({ kind: "ticker", job: "a", everyMs: 6 * 60 * 60_000 })).toBe("every 6 h");
    expect(scheduleText({ kind: "ticker", job: "a", everyMs: 5 * 60_000, dailyAt: "09:30 IST" })).toBe("daily at 09:30 IST");
    expect(scheduleText({ kind: "off", reason: "r", decision: "d" })).toBe("off");
  });
});
