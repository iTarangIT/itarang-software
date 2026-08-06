import { describe, expect, it } from "vitest";

import {
  allowedHosts,
  bearerToken,
  checkClock,
  IngestBody,
  isHostAllowed,
  MAX_BODY_BYTES,
  MAX_LOG_LINES,
  secretMatches,
  withinBodyCap,
} from "../ingest";

/**
 * POST /api/operations/ingest/host is the console's only externally reachable
 * write path, and src/middleware.ts returns early for every /api/* route — so
 * nothing runs in front of it. These checks ARE the security boundary.
 *
 * The plan's §12 names the four rejections that matter: oversized payload,
 * skewed clock, unknown host, bad bearer.
 */

const validPayload = () => ({
  host: "prod",
  captured_at: new Date().toISOString(),
  metrics: { cpu_pct: 31.2, disk_used_pct: 74.3 },
  processes: [{ name: "itarang-crm-web", status: "online", restarts: 3 }],
  logs: [],
});

describe("bearer auth", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("Bearer   spaced  ")).toBe("spaced");
  });

  it("rejects anything that is not a Bearer header", () => {
    expect(bearerToken(null)).toBe("");
    expect(bearerToken("")).toBe("");
    expect(bearerToken("Basic abc123")).toBe("");
    expect(bearerToken("bearer abc123")).toBe(""); // case-sensitive by design
  });

  it("matches only the exact secret", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
    expect(secretMatches("s3cret", "s3crey")).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    // timingSafeEqual throws on unequal lengths; letting that escape would turn
    // a wrong-length secret into a 500 and leak the real secret's length
    // through the difference from a 401.
    expect(() => secretMatches("short", "muchlongersecret")).not.toThrow();
    expect(secretMatches("short", "muchlongersecret")).toBe(false);
  });

  it("rejects empty credentials", () => {
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches("", "s3cret")).toBe(false);
    expect(secretMatches("s3cret", "")).toBe(false);
  });
});

describe("host allowlist", () => {
  it("parses and normalises OPS_INGEST_HOSTS", () => {
    const allow = allowedHosts(" prod, Sandbox ,iot,, ");
    expect([...allow].sort()).toEqual(["iot", "prod", "sandbox"]);
  });

  it("is empty when unset — which the route treats as unconfigured", () => {
    expect(allowedHosts(undefined).size).toBe(0);
    expect(allowedHosts("").size).toBe(0);
  });

  it("accepts only listed hosts, case-insensitively", () => {
    const allow = allowedHosts("prod,sandbox");
    expect(isHostAllowed("prod", allow)).toBe(true);
    expect(isHostAllowed("  PROD ", allow)).toBe(true);
    expect(isHostAllowed("staging", allow)).toBe(false);
  });
});

describe("clock skew", () => {
  const now = Date.parse("2026-08-04T12:00:00.000Z");

  it("accepts a timestamp within ten minutes", () => {
    expect(checkClock("2026-08-04T12:00:00.000Z", now).ok).toBe(true);
    expect(checkClock("2026-08-04T11:52:00.000Z", now).ok).toBe(true);
    expect(checkClock("2026-08-04T12:08:00.000Z", now).ok).toBe(true);
  });

  it("rejects drift in either direction", () => {
    const past = checkClock("2026-08-04T11:30:00.000Z", now);
    expect(past.ok).toBe(false);
    expect(past.skewMinutes).toBe(30);

    const future = checkClock("2026-08-04T12:45:00.000Z", now);
    expect(future.ok).toBe(false);
    expect(future.skewMinutes).toBe(45);
  });

  it("reports an unparseable timestamp distinctly from a skewed one", () => {
    // The route answers 422 with different messages, so an operator can tell
    // "your clock is wrong" from "your agent sent garbage".
    const bad = checkClock("not a date", now);
    expect(bad.capturedAt).toBeNull();
    expect(bad.ok).toBe(false);
  });
});

describe("body cap", () => {
  it("accepts a normal payload", () => {
    expect(withinBodyCap(JSON.stringify(validPayload()))).toBe(true);
  });

  it("rejects a payload over 512 KB", () => {
    expect(withinBodyCap("x".repeat(MAX_BODY_BYTES + 1))).toBe(false);
  });

  it("measures BYTES, not characters", () => {
    // A multi-byte string just under the cap in characters is over it in bytes.
    // Counting characters would let a payload ~3x the intended size through.
    const multibyte = "€".repeat(MAX_BODY_BYTES / 2);
    expect(multibyte.length).toBeLessThan(MAX_BODY_BYTES);
    expect(withinBodyCap(multibyte)).toBe(false);
  });
});

describe("payload schema", () => {
  it("accepts a well-formed agent payload", () => {
    expect(IngestBody.safeParse(validPayload()).success).toBe(true);
  });

  it("defaults the optional sections", () => {
    const parsed = IngestBody.parse({
      host: "prod",
      captured_at: new Date().toISOString(),
    });
    expect(parsed.metrics).toEqual({});
    expect(parsed.processes).toEqual([]);
    expect(parsed.logs).toEqual([]);
  });

  it("requires a host", () => {
    const body = { ...validPayload(), host: "" };
    expect(IngestBody.safeParse(body).success).toBe(false);
  });

  it("rejects out-of-range percentages", () => {
    // A cpu_pct of 4000 would render as a real reading and poison the chart's
    // scale for every other host.
    const body = { ...validPayload(), metrics: { cpu_pct: 4000 } };
    expect(IngestBody.safeParse(body).success).toBe(false);
  });

  it("rejects more than the per-post log cap", () => {
    const line = { service: "web", level: "error", message: "boom" };
    const ok = { ...validPayload(), logs: Array(MAX_LOG_LINES).fill(line) };
    const tooMany = { ...validPayload(), logs: Array(MAX_LOG_LINES + 1).fill(line) };
    expect(IngestBody.safeParse(ok).success).toBe(true);
    expect(IngestBody.safeParse(tooMany).success).toBe(false);
  });

  it("rejects an absurd process list", () => {
    const proc = { name: "p", status: "online" };
    const body = { ...validPayload(), processes: Array(101).fill(proc) };
    expect(IngestBody.safeParse(body).success).toBe(false);
  });

  it("requires a non-empty log message", () => {
    const body = {
      ...validPayload(),
      logs: [{ service: "web", level: "error", message: "" }],
    };
    expect(IngestBody.safeParse(body).success).toBe(false);
  });
});
