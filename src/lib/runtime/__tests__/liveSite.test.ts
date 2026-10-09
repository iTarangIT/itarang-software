import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentJob,
  isLiveSite,
  jobSendsAllowed,
  runAsJob,
  suppressJobSend,
} from "../liveSite";

const SANDBOX = { OPS_APP_NAME: "sandbox-web" };
const LIVE = { OPS_APP_NAME: "itarang-crm-web" };

describe("isLiveSite", () => {
  it("is the live CRM only by its pm2 app name or LIVE_SITE", () => {
    expect(isLiveSite(LIVE)).toBe(true);
    expect(isLiveSite(SANDBOX)).toBe(false);
    expect(isLiveSite({})).toBe(false);
    expect(isLiveSite({ LIVE_SITE: "1" })).toBe(true);
    expect(isLiveSite({ LIVE_SITE: "true" })).toBe(true);
  });

  it("lets LIVE_SITE=0 switch the live box off", () => {
    expect(isLiveSite({ ...LIVE, LIVE_SITE: "0" })).toBe(false);
  });

  it("ignores NODE_ENV, which sandbox shares with production", () => {
    expect(isLiveSite({ ...SANDBOX, NODE_ENV: "production" })).toBe(false);
  });
});

describe("jobSendsAllowed", () => {
  it("allows sends on the live site or with ALLOW_JOB_SENDS=1", () => {
    expect(jobSendsAllowed(LIVE)).toBe(true);
    expect(jobSendsAllowed(SANDBOX)).toBe(false);
    expect(jobSendsAllowed({ ...SANDBOX, ALLOW_JOB_SENDS: "1" })).toBe(true);
  });
});

describe("suppressJobSend", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never drops a send made outside a job (a person's own action)", () => {
    expect(currentJob()).toBeUndefined();
    expect(suppressJobSend("email", SANDBOX)).toBe(false);
  });

  it("drops a job's send off the live site and keeps it on the live site", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    runAsJob("test-job", () => {
      expect(currentJob()).toBe("test-job");
      expect(suppressJobSend("whatsapp", SANDBOX)).toBe(true);
      expect(suppressJobSend("whatsapp", LIVE)).toBe(false);
    });
  });

  it("carries the job into timers the job schedules", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen = await runAsJob(
      "ticker",
      () => new Promise<string | undefined>((resolve) => setTimeout(() => resolve(currentJob()), 0)),
    );
    expect(seen).toBe("ticker");
  });

  it("logs once per job and channel, not on every tick", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runAsJob("quiet-job", () => {
      suppressJobSend("telegram", SANDBOX);
      suppressJobSend("telegram", SANDBOX);
    });
    expect(log).toHaveBeenCalledTimes(1);
  });
});
