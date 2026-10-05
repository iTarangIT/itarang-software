/**
 * Cron routes are on the public list — middleware never asks them for a
 * session — so `Bearer CRON_SECRET` is the whole of their protection.
 *
 * api-auth.contract.test.ts already fails a cron route that never mentions the
 * secret. It cannot see a route that mentions it and then skips the check,
 * which is what the NODE_ENV branch below does. This suite pins the strict
 * helper, and holds the set of routes that relax it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkCronAuth } from "@/lib/cron-auth";

const API_DIR = join(process.cwd(), "src", "app", "api");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const cronRoutes = walk(API_DIR)
  .map((file) => ({
    url: "/api/" + relative(API_DIR, file).split(sep).slice(0, -1).join("/"),
    src: code(file),
  }))
  .filter((r) => /^\/api\/cron\//.test(r.url) || /\/cron(\/|$)/.test(r.url));

const call = (authorization?: string) =>
  checkCronAuth(new Request("http://localhost/api/cron/digest", { headers: authorization ? { authorization } : {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkCronAuth", () => {
  it("treats an unset or empty CRON_SECRET as a broken deployment, never as open", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubEnv("CRON_SECRET", undefined);
    expect(call("Bearer anything")?.status).toBe(500);
    expect(call()?.status).toBe(500);

    // The trap the helper exists for: `Bearer ${""}` must not equal "Bearer ".
    vi.stubEnv("CRON_SECRET", "");
    expect(call("Bearer ")?.status).toBe(500);
  });

  it("refuses a missing or wrong bearer", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    for (const header of [undefined, "", "s3cret", "Bearer", "Bearer wrong", "Bearer s3cretx", "bearer s3cret", "Basic s3cret"]) {
      expect(call(header)?.status, String(header)).toBe(401);
    }
  });

  it("admits the exact bearer, in every environment", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(call("Bearer s3cret")).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(call("Bearer s3cret")).toBeNull();
    expect(call("Bearer wrong")?.status).toBe(401);
  });
});

describe("KNOWN GAP: cron routes that skip the secret outside production", () => {
  it("finds the cron routes", () => {
    expect(cronRoutes.length).toBeGreaterThan(30);
  });

  it("the set of routes with a NODE_ENV branch does not grow", () => {
    // Each of these answers ANY caller when NODE_ENV is not "production" — a
    // deliberate convenience for poking a job from localhost. PM2 sets
    // production, so the VPS is closed. The exposure is a dev server pointed
    // at a shared database (both AWS DBs are reachable from a laptop), worst
    // behind a cloudflared tunnel: an anonymous GET then sends dealer
    // reminders, runs EMI auto-debit, expires coupons.
    //
    // New cron routes should call checkCronAuth() unconditionally and be poked
    // locally with the bearer. Remove a route from this list when its bypass
    // goes; a route that ADDS one fails here.
    const relaxed = cronRoutes
      .filter((r) => /NODE_ENV/.test(r.src))
      .map((r) => r.url)
      .sort();

    expect(relaxed).toEqual([
      "/api/cron/auction/tick",
      "/api/cron/cleanup-leads",
      "/api/cron/dealer-agreement-expiry-reminder",
      "/api/cron/dealer-agreement-refresh",
      "/api/cron/digest",
      "/api/cron/dispatch-to-sold",
      "/api/cron/drive-expenses",
      "/api/cron/drive-sales",
      "/api/cron/gdrive-mirror",
      "/api/cron/iot/scan-offline-batteries",
      "/api/cron/kyc-auto-approval",
      "/api/cron/monitor-morning",
      "/api/cron/nbfc-cor-expiry",
      "/api/cron/nbfc-origination-maintenance",
      "/api/cron/nbfc-request-sla",
      "/api/cron/nbfc/compute-cds",
      "/api/cron/nbfc/compute-pci",
      "/api/cron/nbfc/evaluate-anomaly-flags",
      "/api/cron/nbfc/risk-analysis",
      "/api/cron/nbfc/run-emi-aging",
      "/api/cron/nbfc/run-emi-autodebit",
      "/api/cron/scraper-queue/tick",
      "/api/cron/sla-monitor",
      "/api/cron/zoho-sync",
      "/api/nbfc/dpdpa/retention/cron",
      "/api/nbfc/dual-approval/cron/expire",
    ]);
  });

  it("every such branch is keyed on the literal \"production\" — nothing looser", () => {
    // `=== "development"` would open staging; a typo'd literal would open prod.
    const odd = cronRoutes.flatMap((r) =>
      [...r.src.matchAll(/NODE_ENV\s*([!=]==?)\s*(["'])([^"']*)\2/g)]
        .filter((m) => m[3] !== "production")
        .map((m) => `${r.url}: ${m[0]}`),
    );
    expect(odd).toEqual([]);
  });
});
