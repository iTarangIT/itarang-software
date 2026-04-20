import IORedis from "ioredis";

// Single shared Redis connection, lazy-opened so importing this module
// (or anything that imports it transitively) doesn't hold an idle TCP
// socket against Upstash. This matters because Upstash counts every
// command — and even keep-alive PINGs from idle clients add up against
// the free-tier 500k requests/day cap.
//
// `lazyConnect: true` means ioredis won't dial the server until the
// first command is issued. The error listener prevents Node from
// printing "[ioredis] Unhandled error event" and crashing the process
// when transient network errors occur.
export const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  enableOfflineQueue: true,
  // Be polite to Upstash — back off harder on repeated failures so we
  // don't hammer the API once the daily quota is hit.
  retryStrategy: (times) => Math.min(1000 * 2 ** times, 30_000),
  reconnectOnError: (err) => {
    // If we've exhausted Upstash's request quota, don't keep retrying —
    // it just spends more requests on rejected commands.
    if (/max requests limit/i.test(err.message)) return false;
    return true;
  },
});

connection.on("error", (err) => {
  // Suppress noisy reconnect errors; only log distinct failure modes.
  if (/max requests limit/i.test(err.message)) {
    console.error(
      "[redis] Upstash request quota exhausted — Redis-backed features will fail until the quota resets. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit",
    );
    return;
  }
  console.error("[redis] connection error:", err.message);
});
