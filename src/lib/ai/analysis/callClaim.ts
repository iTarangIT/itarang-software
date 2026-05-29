// Cross-instance dedup for provider call completion events. The same call
// can be observed by:
//   - the provider's webhook
//   - /api/cron/dialer-poll (poll backstop)
//   - the dev-side polling tick inside callWorker
// All three race for the same call_id. First one to claim runs the
// post-call work; the rest no-op.

import { dedupClaim } from "@/lib/queue/safeRedis";

const PROCESSED_CALL_TTL_SECONDS = 10 * 60;

export async function claimCallForProcessing(
  provider: "bolna" | "elevenlabs",
  callId: string,
): Promise<boolean> {
  if (!callId) return false;
  const { claimed, degraded } = await dedupClaim(
    `${provider}:processed-call:${callId}`,
    PROCESSED_CALL_TTL_SECONDS,
    `${provider}:webhook-dedup`,
  );
  if (degraded) {
    console.warn(
      `[${provider}:claim] dedup falling back to process-local LRU (Redis degraded) for ${callId}`,
    );
  }
  return claimed;
}
