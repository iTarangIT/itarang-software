import { connection, isUpstashQuotaError, tripQuotaCircuit } from "./connection";
import { log } from "@/lib/log";

/**
 * Resilient wrapper for a Redis operation.
 *
 * On Upstash quota exhaustion: flips the shared circuit, logs once (deduped),
 * and returns `fallback`. For any other error: rethrows — we intentionally
 * do NOT swallow unknown errors, because that would mask real bugs (wrong
 * key type, network partition, etc.).
 *
 * The `label` is the log key. Keep it short and stable; two call sites with
 * the same label dedupe together.
 */
export async function safeRedis<T>(
  op: () => Promise<T>,
  fallback: T,
  label: string,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (isUpstashQuotaError(err)) {
      tripQuotaCircuit();
      log.warn(`[redis] op degraded: ${label}`);
      return fallback;
    }
    throw err;
  }
}

/**
 * `SET key 1 EX ttlSec NX` with quota-aware fallback.
 *
 * Returns:
 *   { claimed: true,  degraded: false } — we hold the lock
 *   { claimed: false, degraded: false } — someone else holds it
 *   { claimed: true,  degraded: true  } — Redis unavailable; bias toward
 *                                         processing. Callers that need
 *                                         strict exclusion must branch on
 *                                         `degraded` and choose the safer
 *                                         path for their context.
 *
 * The "bias toward processing" default matches the webhook-dedup use case
 * (better to process a duplicate Bolna webhook than drop a terminal event)
 * and the scraper finalize-lock (already had inline "proceed without lock
 * on Redis failure" logic pre-refactor).
 */
export async function safeRedisLock(
  key: string,
  ttlSec: number,
  label: string,
): Promise<{ claimed: boolean; degraded: boolean }> {
  try {
    const result = await connection.set(key, "1", "EX", ttlSec, "NX");
    return { claimed: result === "OK", degraded: false };
  } catch (err) {
    if (isUpstashQuotaError(err)) {
      tripQuotaCircuit();
      log.warn(`[redis] lock degraded: ${label}`);
      return { claimed: true, degraded: true };
    }
    throw err;
  }
}

// Process-local LRU dedup for the Redis-degraded path. Catches the common
// case where a duplicate webhook (e.g., Bolna sends "call-disconnected" then
// "completed" for the same call) hits the same Node process within a few
// minutes. Doesn't help across PM2 cluster workers or a horizontal scale-out,
// but the current Hostinger deployment is single-instance — good enough to
// prevent double-billed analysis on the rare Upstash quota exhaustion.
const LOCAL_DEDUP_TTL_MS = 10 * 60 * 1000;
const LOCAL_DEDUP_MAX_ENTRIES = 2000;
const localDedupExpiries = new Map<string, number>();

function checkAndClaimLocalDedup(key: string): boolean {
  const now = Date.now();

  // Lazy sweep when we're getting big — cheaper than running on every claim.
  if (localDedupExpiries.size > LOCAL_DEDUP_MAX_ENTRIES / 2) {
    for (const [k, expiresAt] of localDedupExpiries) {
      if (expiresAt <= now) localDedupExpiries.delete(k);
    }
  }

  const existing = localDedupExpiries.get(key);
  if (existing && existing > now) return false; // already claimed in this process

  localDedupExpiries.set(key, now + LOCAL_DEDUP_TTL_MS);

  // Hard cap on size — evict oldest insertions (JS Map preserves order).
  while (localDedupExpiries.size > LOCAL_DEDUP_MAX_ENTRIES) {
    const firstKey = localDedupExpiries.keys().next().value;
    if (firstKey === undefined) break;
    localDedupExpiries.delete(firstKey);
  }

  return true;
}

/**
 * Like `safeRedisLock` but with a process-local fallback when Redis is
 * degraded: instead of biasing toward "claimed=true" (which lets duplicates
 * through), check an in-memory LRU first. Use this for non-terminal-only
 * webhook dedup where duplicates carry a real cost (extra LLM analysis,
 * extra dialer trigger).
 *
 * Returns { claimed, degraded } where `degraded=true` means we fell back to
 * the local set — caller can decide whether to log it.
 */
export async function dedupClaim(
  key: string,
  ttlSec: number,
  label: string,
): Promise<{ claimed: boolean; degraded: boolean }> {
  const result = await safeRedisLock(key, ttlSec, label);
  if (!result.degraded) return result;
  const claimed = checkAndClaimLocalDedup(key);
  return { claimed, degraded: true };
}
