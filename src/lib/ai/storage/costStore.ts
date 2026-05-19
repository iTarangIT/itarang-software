// Best-effort post-call cost capture. Called from finalizeBolnaCall and
// finalizeElevenLabsCall after the ai_call_logs row has been upserted, and
// re-invoked from /api/cron/backfill-call-costs for rows that webhooks
// missed.
//
// The provider APIs (Bolna /executions/{id}, ElevenLabs /v1/convai/
// conversations/{id}) finalize cost on their side a few seconds after the
// call ends — so the webhook path occasionally races and gets nulls. That's
// fine: the backfill cron picks those up. Failure is logged, never thrown.

import { db } from "@/lib/db";
import { aiCallLogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchBolnaCallCost, type NormalizedCallCost } from "@/lib/ai/bolna_ai/fetchCallCost";
import { fetchElevenLabsCallCost } from "@/lib/ai/elevenlabs/fetchCallCost";

type Provider = "bolna" | "elevenlabs";

export async function fetchAndPersistCallCost(
  provider: Provider,
  callId: string,
): Promise<void> {
  if (!callId) return;
  try {
    const cost: NormalizedCallCost =
      provider === "bolna"
        ? await fetchBolnaCallCost(callId)
        : await fetchElevenLabsCallCost(callId);

    if (!cost.success) {
      console.warn(
        `[cost] ${provider} fetch failed for ${callId}: ${cost.error ?? "unknown"}`,
      );
      return;
    }

    // If the provider returned a row with no usable cost data, don't stamp
    // cost_fetched_at — leave it null so the backfill cron retries.
    if (
      cost.totalCents == null &&
      cost.llmCents == null &&
      cost.ttsCents == null &&
      cost.sttCents == null &&
      cost.telephonyCents == null &&
      cost.platformCents == null
    ) {
      console.warn(
        `[cost] ${provider} returned no cost fields for ${callId} — will retry via backfill`,
      );
      return;
    }

    await db
      .update(aiCallLogs)
      .set({
        total_cost_cents: cost.totalCents,
        llm_cost_cents: cost.llmCents,
        tts_cost_cents: cost.ttsCents,
        stt_cost_cents: cost.sttCents,
        telephony_cost_cents: cost.telephonyCents,
        platform_cost_cents: cost.platformCents,
        cost_currency: cost.currency,
        cost_source: cost.source,
        cost_fetched_at: new Date(),
      })
      .where(eq(aiCallLogs.call_id, callId));
  } catch (err) {
    console.error(`[cost] ${provider} persist failed for ${callId}:`, err);
  }
}
