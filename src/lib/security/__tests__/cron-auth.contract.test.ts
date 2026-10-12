/**
 * Cron routes are on the public list — middleware never asks them for a
 * session — so `Bearer CRON_SECRET` is the whole of their protection.
 *
 * api-auth.contract.test.ts already fails a cron route that never mentions the
 * secret. It cannot see a route that mentions it and then skips the check.
 * This suite pins the strict helpers and fails any route that relaxes them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkCronAuth, isCronAuthorised, isNbfcTestBypass } from "@/lib/cron-auth";

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

describe("isCronAuthorised (boolean form)", () => {
  const req = (authorization?: string) =>
    new Request("http://localhost/api/cron/digest", { headers: authorization ? { authorization } : {} });

  it("fails closed when CRON_SECRET is unset, in every environment", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("CRON_SECRET", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(isCronAuthorised(req())).toBe(false);
    expect(isCronAuthorised(req("Bearer undefined"))).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(isCronAuthorised(req("Bearer "))).toBe(false);
  });

  it("admits only the exact bearer", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isCronAuthorised(req("Bearer s3cret"))).toBe(true);
    for (const h of [undefined, "Bearer wrong", "Bearer s3cretx", "s3cret"]) {
      expect(isCronAuthorised(req(h)), String(h)).toBe(false);
    }
  });

  it("ignores x-vercel-cron off Vercel", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("VERCEL", undefined);
    const r = new Request("http://localhost/api/cron/digest", { headers: { "x-vercel-cron": "1" } });
    expect(isCronAuthorised(r)).toBe(false);
  });
});

describe("isNbfcTestBypass", () => {
  const req = (v?: string) =>
    new Request("http://localhost/api/cron/auction/tick", { headers: v ? { "x-nbfc-test-bypass": v } : {} });

  it("needs the flag, a secret, non-production and an exact match", () => {
    vi.stubEnv("NBFC_TEST_BYPASS", "1");
    vi.stubEnv("NBFC_TEST_BYPASS_SECRET", "tb");
    vi.stubEnv("NODE_ENV", "test");
    expect(isNbfcTestBypass(req("tb"))).toBe(true);
    expect(isNbfcTestBypass(req("tbx"))).toBe(false);
    expect(isNbfcTestBypass(req())).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(isNbfcTestBypass(req("tb"))).toBe(false);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NBFC_TEST_BYPASS", "0");
    expect(isNbfcTestBypass(req("tb"))).toBe(false);
  });
});

describe("no route fails OPEN when CRON_SECRET is missing (ID 130)", () => {
  it("finds the cron routes", () => {
    expect(cronRoutes.length).toBeGreaterThan(30);
  });

  it("never compares a bearer by hand", () => {
    // `if (CRON_SECRET && header !== …)` / `if (expected && auth === …)` skip
    // the check when the env var is unset; a raw `=== \`Bearer ${…}\`` is not
    // constant-time. checkCronAuth() / isCronAuthorised() replace them all.
    const open = walk(API_DIR)
      .map((file) => ({
        url: "/api/" + relative(API_DIR, file).split(sep).slice(0, -1).join("/"),
        src: code(file),
      }))
      .filter(
        (r) =>
          /process\.env\.CRON_SECRET\s*&&/.test(r.src) ||
          /[!=]==?\s*`Bearer \$\{/.test(r.src) ||
          /`Bearer \$\{[^}]*\}`\s*[!=]==?/.test(r.src),
      )
      .map((r) => r.url);
    expect(open).toEqual([]);
  });

  it("no cron route has a NODE_ENV branch", () => {
    // These used to answer ANY caller when NODE_ENV was not "production" — a
    // dev server pointed at a shared database could then send dealer
    // reminders or run EMI auto-debit for an anonymous GET. Poke a job locally
    // with the bearer from .env.local instead.
    const relaxed = cronRoutes.filter((r) => /NODE_ENV/.test(r.src)).map((r) => r.url);
    expect(relaxed).toEqual([]);
  });
});
