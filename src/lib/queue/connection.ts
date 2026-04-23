import IORedis from "ioredis";
import { log } from "@/lib/log";

/*
 * ============================================================================
 * TWO Redis connections. This is not a mistake.
 * ============================================================================
 *
 * BullMQ REQUIRES different ioredis settings depending on whether the client
 * is used for blocking commands (Worker, QueueEvents — they BRPOPLPUSH with
 * long timeouts) or non-blocking commands (Queue.add, plain GET/SET/DEL).
 *
 *   blockingConnection → maxRetriesPerRequest: null
 *     Required by BullMQ. If you set a finite number, blocking reads time
 *     out and the Worker crashes with an opaque "Connection ... got
 *     destroyed" error. See BullMQ docs + https://github.com/taskforcesh/bullmq/issues/1070.
 *
 *   connection          → maxRetriesPerRequest: 2
 *     For every other Redis caller. The finite cap is the defence against
 *     the 2026-04-23 incident, where `null` on the *only* shared connection
 *     let ioredis retry failed commands forever during Upstash quota
 *     exhaustion — each retry emitting a 2 KB stack trace until stderr
 *     filled 60 GB of disk.
 *
 * DO NOT "simplify" this back to one connection. DO NOT change blocking to
 * a finite retry count or non-blocking to `null`. Both knobs are load-bearing.
 * If a future BullMQ major changes the requirement, update this file + the
 * incident doc together.
 * ============================================================================
 */

const REDIS_URL = process.env.REDIS_URL!;

/**
 * Dedicated connection for BullMQ blocking clients (Worker, QueueEvents).
 * Do not reuse for non-blocking commands — a blocking BRPOPLPUSH will
 * monopolise the socket and stall anything else on the same client.
 */
export const blockingConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, // REQUIRED by BullMQ for blocking clients.
  lazyConnect: true,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(1000 * 2 ** times, 30_000),
  reconnectOnError: quotaAwareReconnect,
});

/**
 * Shared connection for non-blocking commands:
 *   - Queue.add (job enqueue)
 *   - safeRedis / safeRedisLock (dialer session, webhook dedup, scraper lock)
 *   - any direct GET/SET/DEL
 */
export const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2, // bounded retry budget — see incident note above.
  lazyConnect: true,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(1000 * 2 ** times, 30_000),
  reconnectOnError: quotaAwareReconnect,
});

function quotaAwareReconnect(err: Error): boolean {
  // When Upstash has rejected us with a quota error at the connection level,
  // reconnecting just spends more of our already-depleted request budget on
  // immediately-rejected commands. Let the downstream caller handle it.
  if (isUpstashQuotaError(err)) return false;
  return true;
}

for (const [label, conn] of [
  ["blocking", blockingConnection],
  ["non-blocking", connection],
] as const) {
  conn.on("error", (err) => {
    if (isUpstashQuotaError(err)) {
      recordQuotaError();
      log.warn(`[redis:${label}] quota error (circuit=${quotaCircuit.open})`);
      return;
    }
    log.error(`[redis:${label}] connection error`, { message: err.message });
  });
}

/**
 * Single source of truth for "is this the Upstash daily-quota error?".
 * Upstash returns the quota breach as a command-level `ReplyError`, NOT a
 * connection-level error — that is why the earlier reconnectOnError filter
 * alone did not stop the retry loop during the incident.
 */
export function isUpstashQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  return /max requests limit/i.test(msg);
}

/**
 * In-process circuit breaker for Upstash quota exhaustion.
 *
 * Threshold: circuit trips only after >THRESHOLD quota errors within
 * WINDOW_MS. This avoids false-positive trips on a transient single blip,
 * while still catching the incident scenario (200 errors/second will hit
 * the threshold in <50 ms).
 *
 * Cooldown is EXPONENTIAL, doubling on every successive trip — not a flat
 * 60s. If the quota is done for the rest of the day, a flat-60s cooldown
 * would still retry every minute for hours; exponential is capped at 1h.
 */
const WINDOW_MS = 60_000;
const TRIP_THRESHOLD = 5;
const COOLDOWN_BASE_MS = 60_000; //  1 min
const COOLDOWN_CAP_MS = 60 * 60_000; // 60 min

let errorTimestamps: number[] = [];
let consecutiveTrips = 0;

export const quotaCircuit = {
  open: false,
  reopenAt: 0,
  /**
   * Refresh the circuit. Auto-closes once the cooldown has elapsed.
   * Returns the current `open` value after any state transition.
   */
  tick(): boolean {
    if (this.open && Date.now() >= this.reopenAt) {
      this.open = false;
      this.reopenAt = 0;
      log.info("[redis] quota circuit closed — traffic resuming");
      // Don't reset consecutiveTrips yet — if quota is still dead the next
      // trip will extend cooldown based on the pattern. Reset on the first
      // genuinely successful window.
    }
    return this.open;
  },
};

/**
 * Called by the ioredis `error` listeners when a quota error is observed.
 * Records the timestamp, prunes the window, and trips the circuit if the
 * threshold has been crossed.
 */
export function recordQuotaError(): void {
  const now = Date.now();
  errorTimestamps.push(now);
  // Prune anything outside the rolling window.
  const cutoff = now - WINDOW_MS;
  errorTimestamps = errorTimestamps.filter((t) => t >= cutoff);
  if (errorTimestamps.length > TRIP_THRESHOLD && !quotaCircuit.open) {
    tripQuotaCircuit();
  }
}

/**
 * Explicit trip (also called by safeRedis + callWorker when they see a
 * quota error on a specific command, so they don't have to wait for the
 * rolling window to hit threshold).
 */
export function tripQuotaCircuit(): void {
  const wasClosed = !quotaCircuit.open;
  consecutiveTrips = wasClosed ? 1 : Math.min(consecutiveTrips + 1, 10);
  const cooldown = Math.min(
    COOLDOWN_BASE_MS * 2 ** (consecutiveTrips - 1),
    COOLDOWN_CAP_MS,
  );
  quotaCircuit.open = true;
  quotaCircuit.reopenAt = Math.max(quotaCircuit.reopenAt, Date.now() + cooldown);

  if (wasClosed) {
    // PM2 surfaces process warning events in its log stream — push signal
    // without new alerting infra.
    process.emitWarning("Upstash quota exhausted", { code: "UPSTASH_QUOTA" });
    log.warn(
      `[redis] quota circuit OPEN — cooldown ${Math.round(cooldown / 1000)}s (trip #${consecutiveTrips})`,
    );
  }
}

/**
 * Test-only helper — not for production code.
 */
export function _resetQuotaCircuitForTests(): void {
  quotaCircuit.open = false;
  quotaCircuit.reopenAt = 0;
  errorTimestamps = [];
  consecutiveTrips = 0;
}
