/**
 * ElevenLabs credit balance and quota.
 *
 * THE ONE GENUINELY NEW INTEGRATION IN THE SPEND MODULE. Everything else in
 * /operations/spend reads tables we already write. Nothing in this codebase
 * polls ElevenLabs for the balance, so a credit burn-out is invisible until
 * calls start failing — and the dialer's failure mode when credits run out is
 * a call that simply does not connect, which reads as a telephony problem.
 *
 * API (same auth as src/lib/ai/elevenlabs/fetchCallCost.ts):
 *   GET {ELEVENLABS_API_BASE_URL}/v1/user/subscription
 *   header: xi-api-key: ELEVENLABS_API_KEY
 *
 * Response fields used:
 *   character_count                    — consumed this billing period
 *   character_limit                    — the period's quota
 *   next_character_count_reset_unix    — when it resets (seconds)
 *   tier / status                      — plan context for the tooltip
 *
 * "Credits" and "characters" are the same meter on this account: the Usage
 * panel prices 31,000 credits at ₹495.20, which is where the 0.0159742 ₹/credit
 * rate in fetchCallCost.ts comes from. Remaining = limit - count.
 */

import type { CollectedSample, OpsCollector } from "../types";
import { MINUTE } from "../types";

const BASE_URL =
  process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";

interface SubscriptionResponse {
  character_count?: number;
  character_limit?: number;
  next_character_count_reset_unix?: number;
  tier?: string;
  status?: string;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export const elevenLabsCollector: OpsCollector = {
  id: "vendor.elevenlabs",
  label: "ElevenLabs credits & quota",
  // A balance moves slowly and this is a third-party call on the critical path
  // of nothing. Hourly is frequent enough to catch a burn-down with days to
  // spare, and leaves the vendor's rate limit alone.
  intervalMs: 60 * MINUTE,
  timeoutMs: 15_000,

  async run(): Promise<CollectedSample[]> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      // Unconfigured is a deployment fact, not a fault. Returning nothing keeps
      // the collector green; a thrown error here would put a permanent red row
      // on /operations/jobs for every environment without the key.
      return [];
    }

    const response = await fetch(`${BASE_URL}/v1/user/subscription`, {
      headers: { "xi-api-key": apiKey },
      // Below the collector's own timeoutMs, so a hung vendor surfaces as this
      // error rather than as the runner's blunter "timed out after 15000ms".
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs subscription HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as SubscriptionResponse;

    const used = finite(data.character_count);
    const limit = finite(data.character_limit);
    const resetUnix = finite(data.next_character_count_reset_unix);
    const resetAt = resetUnix ? new Date(resetUnix * 1000).toISOString() : null;

    const meta = {
      tier: data.tier ?? null,
      status: data.status ?? null,
      used,
      limit,
      reset_at: resetAt,
    };

    const samples: CollectedSample[] = [];

    if (used != null && limit != null) {
      samples.push({
        metric_key: "vendor.credits_remaining",
        source: "vendor:elevenlabs",
        // Clamped at zero: an over-quota account reports used > limit, and a
        // negative "remaining" would read as a data bug rather than as the
        // outage it actually is.
        value_num: Math.max(0, limit - used),
        meta,
      });

      if (limit > 0) {
        samples.push({
          metric_key: "vendor.credits_used_pct",
          source: "vendor:elevenlabs",
          value_num: Math.round((used / limit) * 1000) / 10,
          meta,
        });
      }
    }

    return samples;
  },
};
