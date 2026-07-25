import type { NextRequest } from "next/server";

/**
 * Best-effort per-IP limiter for the unauthenticated forgot-password endpoint.
 *
 * WHY IN-PROCESS: there is no Redis-backed limiter in active use in this
 * codebase — the BullMQ/Upstash wiring is documented dead code (see
 * src/lib/buyback/dispatch.ts's header). So this is a plain Map.
 *
 * KNOWN LIMITS, stated rather than glossed: it is per Node process, it resets
 * on deploy/restart, and it does not span instances. That is acceptable because
 * this is the SECOND layer — the authoritative throttle is the per-account
 * check against password_reset_tokens in the route, which is durable and
 * shared. This layer exists for the one attack the durable layer structurally
 * cannot see: an enumeration sweep across thousands of addresses hits the
 * no-match path and writes NO rows, so there is nothing for a DB counter to
 * count. The app runs as a single `node server.js` (package.json `start`), so
 * today this is effectively global; revisit if the deploy ever goes
 * multi-instance, where it becomes 10-per-instance.
 *
 * Returning 429 from here is safe for enumeration purposes: it is keyed on IP,
 * not on whether the address exists.
 */

const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX = 10;
// Hard cap so a spoofed-header flood cannot leak memory. Same defensive shape
// as src/lib/log.ts's MAX_ENTRIES.
const MAX_KEYS = 2000;

type Bucket = { count: number; windowStart: number };

const hits = new Map<string, Bucket>();

function prune(now: number): void {
  for (const [key, bucket] of hits) {
    if (now - bucket.windowStart >= IP_WINDOW_MS) hits.delete(key);
  }
  if (hits.size < MAX_KEYS) return;
  // Still over cap after pruning expired entries — evict oldest-first.
  const sorted = [...hits.entries()].sort(
    (a, b) => a[1].windowStart - b[1].windowStart,
  );
  for (const [key] of sorted.slice(0, hits.size - MAX_KEYS + 1)) {
    hits.delete(key);
  }
}

/** Consume one token for this IP. Returns false when the caller should 429. */
export function takeIpToken(ip: string): boolean {
  const now = Date.now();
  prune(now);

  const bucket = hits.get(ip);
  if (!bucket || now - bucket.windowStart >= IP_WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= IP_MAX) return false;
  bucket.count += 1;
  return true;
}

export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
