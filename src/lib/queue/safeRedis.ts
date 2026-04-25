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
