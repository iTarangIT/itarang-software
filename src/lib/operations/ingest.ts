/**
 * Validation for POST /api/operations/ingest/host.
 *
 * Split out of the route so it can be unit-tested without a database. The route
 * imports `db` (transitively, through the runner), so a test that only wants to
 * check "is a skewed clock rejected?" would otherwise need a live connection to
 * find out — and a security boundary you cannot cheaply test is one nobody
 * re-tests after changing it.
 *
 * THIS IS THE ONLY GATE. src/middleware.ts returns early for every /api/* path,
 * so nothing runs in front of the handler. Every check here is load-bearing.
 */

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Bigger than any honest agent payload; small enough not to be a memory lever. */
export const MAX_BODY_BYTES = 512 * 1024;
/** Per POST. The agent drops the overflow rather than batching it up. */
export const MAX_LOG_LINES = 200;
/** A clock this far out makes every timestamp on the dashboard a lie. */
export const MAX_CLOCK_SKEW_MS = 10 * 60_000;
/** One accepted post per host per minute. */
export const MIN_POST_INTERVAL_MS = 60_000;

export const HostMetrics = z.object({
  cpu_pct: z.number().min(0).max(100).optional(),
  load1: z.number().min(0).optional(),
  mem_used_pct: z.number().min(0).max(100).optional(),
  swap_used_pct: z.number().min(0).max(100).optional(),
  disk_used_pct: z.number().min(0).max(100).optional(),
  disk_free_gb: z.number().min(0).optional(),
  inode_used_pct: z.number().min(0).max(100).optional(),
  uptime_s: z.number().min(0).optional(),
  cert_days_left: z.number().optional(),
});

export const ProcessEntry = z.object({
  name: z.string().min(1).max(80),
  status: z.string().min(1).max(32),
  restarts: z.number().int().min(0).optional(),
  mem_mb: z.number().min(0).optional(),
  cpu_pct: z.number().min(0).optional(),
  uptime_s: z.number().min(0).optional(),
});

export const LogLine = z.object({
  ts: z.string().optional(),
  service: z.string().min(1).max(120),
  level: z.string().min(1).max(16),
  message: z.string().min(1),
});

export const IngestBody = z.object({
  host: z.string().min(1).max(32),
  captured_at: z.string(),
  metrics: HostMetrics.default({}),
  processes: z.array(ProcessEntry).max(100).default([]),
  logs: z.array(LogLine).max(MAX_LOG_LINES).default([]),
});

export type IngestPayload = z.infer<typeof IngestBody>;
export type IngestLogLine = z.infer<typeof LogLine>;

/**
 * Constant-time secret comparison.
 *
 * timingSafeEqual throws on a length mismatch, which would itself leak the
 * secret's length through the difference between a 500 and a 401 — so lengths
 * are checked first and a mismatch takes the same path as a wrong secret.
 */
export function secretMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | null | undefined): string {
  if (!header) return "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** The OPS_INGEST_HOSTS allowlist, normalised. */
export function allowedHosts(raw = process.env.OPS_INGEST_HOSTS): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isHostAllowed(host: string, allow: Set<string>): boolean {
  return allow.has(host.trim().toLowerCase());
}

export interface ClockCheck {
  ok: boolean;
  /** Absolute skew in minutes, for the rejection message. */
  skewMinutes: number;
  capturedAt: Date | null;
}

/**
 * Is the agent's clock close enough to ours to trust its timestamps?
 *
 * A box whose clock has drifted writes samples into the past or the future,
 * where the freshness maths and every chart quietly disagree with reality.
 */
export function checkClock(capturedAt: string, now = Date.now()): ClockCheck {
  const parsed = new Date(capturedAt);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, skewMinutes: Infinity, capturedAt: null };
  }
  const skew = Math.abs(now - parsed.getTime());
  return {
    ok: skew <= MAX_CLOCK_SKEW_MS,
    skewMinutes: Math.round(skew / 60_000),
    capturedAt: parsed,
  };
}

/** Is this body within the size cap? Checked against the bytes that arrived. */
export function withinBodyCap(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= MAX_BODY_BYTES;
}
