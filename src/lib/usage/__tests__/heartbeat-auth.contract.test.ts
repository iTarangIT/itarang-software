/**
 * Who a usage heartbeat is recorded against, and who may read the result.
 *
 * moduleUsageMath.test.ts pins the constants and normaliseModule(); this pins
 * the two routes that sit either side of them. Both import the database, so
 * they are read as source text — the technique of
 * security/__tests__/api-auth.contract.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isPublicApiPath } from "@/lib/security/publicApi";

import { MODULES, normaliseModule } from "../constants";

const code = (...parts: string[]) =>
  readFileSync(join(process.cwd(), "src", ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const heartbeat = code("app", "api", "usage", "heartbeat", "route.ts");
const consoleRead = code("app", "api", "operations", "usage", "route.ts");
const track = code("lib", "usage", "track.ts");

describe("POST /api/usage/heartbeat", () => {
  it("is not on the public list — a heartbeat needs a session", () => {
    expect(isPublicApiPath("/api/usage/heartbeat")).toBe(false);
  });

  it("takes the user and the role from the session, for both writes", () => {
    expect(heartbeat).toMatch(/\brequireAuth\s*\(/);
    expect(heartbeat.match(/userId:\s*user\.id\b/g)).toHaveLength(2);
    expect(heartbeat.match(/role:\s*user\.role\b/g)).toHaveLength(2);
  });

  it("never reads an identity from the body — a client-asserted role would let an external count as staff", () => {
    expect(heartbeat).not.toMatch(/body\s*[?!]?\.\s*(user_?id|userId|role|email)\b/);
    // The only two things it takes from the client.
    const read = [...heartbeat.matchAll(/body\s*[?!]?\.\s*(\w+)/g)].map((m) => m[1]);
    expect([...new Set(read)].sort()).toEqual(["module", "session_id"]);
  });

  it("drops a session id that is not a UUID before anything is written", () => {
    const guard = heartbeat.indexOf("isUuid(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(heartbeat.indexOf("recordHeartbeat("));
  });

  it("checks the off switch before it touches auth or the database", () => {
    expect(heartbeat.indexOf("usageHeartbeatEnabled()")).toBeLessThan(heartbeat.indexOf("requireAuth("));
  });

  it("answers the same thing whatever happened, so it cannot be used to probe session ids", () => {
    expect(heartbeat).not.toMatch(/status:\s*(4|5)\d\d/);
  });
});

describe("the module label from the browser", () => {
  it("is coerced onto the allow-list by the writer", () => {
    expect(track).toMatch(/\bnormaliseModule\s*\(/);
    expect(normaliseModule("/admin/users")).toBe("other");
    expect(normaliseModule("ceo'; drop table users;--")).toBe("other");
    expect(normaliseModule({ module: "ceo" })).toBe("other");
  });

  it("KNOWN GAP: is not checked against the caller's role", () => {
    // normaliseModule() only asks "is this a real module?", never "is it one
    // this role can open?". A dealer can POST module:"ceo" and show up in that
    // module's per-user drill-down. The label is client-asserted by design
    // (the path never leaves the tab), so the fix is a role → modules map
    // applied in recordModuleUsage, not a change here.
    for (const m of MODULES) expect(normaliseModule(m)).toBe(m);
    expect(track).not.toMatch(/normaliseModule\s*\([^)]*role/);
  });
});

describe("KNOWN GAP: the session limits are enforced only in the browser", () => {
  it("track.ts never reads IDLE_MS or MAX_SESSION_MS", () => {
    // The server throttles re-pings on an EXISTING session id, but a fresh
    // UUID per request takes the insert path every time, each worth one
    // heartbeat of engaged time. A signed-in user can therefore inflate their
    // own figures without limit; they cannot write against anyone else.
    // Fix: cap new sessions per user per day in recordHeartbeat.
    expect(track).not.toMatch(/\b(IDLE_MS|MAX_SESSION_MS)\b/);
  });
});

describe("GET /api/operations/usage", () => {
  it("is not on the public list, and the ingest rule beside it does not swallow it", () => {
    expect(isPublicApiPath("/api/operations/usage")).toBe(false);
    expect(isPublicApiPath("/api/operations/ingest/host")).toBe(true);
  });

  it("is guarded by the usage-analytics check, not the wider operations one", () => {
    // Per-person usage is narrower than the infrastructure console: CEO and
    // admin are refused here on purpose.
    expect(consoleRead).toMatch(/\brequireUsageAnalyticsAdmin\s*\(/);
    expect(consoleRead).not.toMatch(/\brequireOperationsAdmin\s*\(/);
  });
});
