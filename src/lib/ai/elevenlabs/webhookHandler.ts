// Thin adapter: receives a verified ElevenLabs webhook event, normalizes it
// into the shared finalize payload, and hands off to finalizeElevenLabsCall.
// All post-call work lives in finalizeCall.ts so the polling backstop runs
// the same code path.

import { finalizeElevenLabsCall } from "./finalizeCall";
import { db } from "@/lib/db";
import { dialerCampaignLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { completeCampaignLead } from "@/lib/queue/campaignTracker";
import { classifyCallEnd } from "@/lib/ai-dialer/campaignLeadStatus";
import { applyPostCall, preparePostCall } from "@/lib/ai-dialer/postCallOutcome";
import type { ElevenLabsWebhookEvent } from "./types";
import { normalizePostCall } from "./normalizePostCall";
import { noteTriggerResult } from "@/lib/ai-dialer/lineHealth";
import { recordDialDisposition } from "@/lib/ai/storage/dialDisposition";
import { writeAiCallTouchpoint } from "@/lib/ai/storage/callTouchpoint";

/**
 * The telephony detail on a call_initiation_failure.
 *
 * The metadata shape depends on the phone provider — SIP carries
 * sip_status_code / error_reason, Twilio its StatusCallback body (CallStatus,
 * SipResponseCode) — and may sit at the top level or under `body`. Read
 * defensively and return nothing rather than guess.
 */
function initiationTelephony(metadata: unknown): {
  sipStatusCode: string | null;
  detail: string | null;
} {
  const layers = [metadata, (metadata as { body?: unknown } | null)?.body].filter(
    (l): l is Record<string, unknown> => l !== null && typeof l === "object",
  );
  const pick = (...keys: string[]): string | null => {
    for (const layer of layers) {
      for (const k of keys) {
        const v = layer[k];
        if ((typeof v === "string" && v.trim()) || typeof v === "number") return `${v}`.trim();
      }
    }
    return null;
  };
  return {
    sipStatusCode: pick("sip_status_code", "SipResponseCode"),
    detail: pick("error_reason", "sip_status", "CallStatus"),
  };
}

export async function handleElevenLabsWebhook(event: ElevenLabsWebhookEvent) {
  try {
    if (event.type === "post_call_audio") {
      // Audio webhook is informational only; we don't store audio.
      return;
    }

    if (event.type === "call_initiation_failure") {
      const data = event.data;
      console.log("[ELEVENLABS] Call initiation failed:", {
        conversation_id: data.conversation_id,
        reason: data.failure_reason,
      });
      // Failed initiations should still advance the dialer. Look up the
      // campaign-lead row by the conversation id we stored at trigger time
      // (the bolna_call_id column doubles for both providers), mark it
      // failed, then advance the parent campaign.
      try {
        const row = await db
          .select({
            id: dialerCampaignLeads.id,
            lead_id: dialerCampaignLeads.lead_id,
            campaign_id: dialerCampaignLeads.campaign_id,
          })
          .from(dialerCampaignLeads)
          // No id → no row, same as before (an undefined bind used to throw
          // into the catch below).
          .where(eq(dialerCampaignLeads.bolna_call_id, data.conversation_id ?? ""))
          .limit(1);
        if (row[0]) {
          const telephony = initiationTelephony(data.metadata);
          // busy / no-answer / unknown, sharpened by the SIP code or Twilio
          // CallStatus when the reason alone says "unknown".
          const callEnd = classifyCallEnd({
            initiationFailureReason: [data.failure_reason, telephony.detail]
              .filter(Boolean)
              .join(" "),
            sipStatusCode: telephony.sipStatusCode,
          });
          // Dispositions v3 — keep the SIP code on the outcome, so the retry
          // policy and the carrier-refusal counter read it like a trigger failure.
          const outcome =
            (data.failure_reason ?? "initiation_failed") +
            (telephony.sipStatusCode ? ` (sip status: ${telephony.sipStatusCode})` : "");
          const failureText = [data.failure_reason, telephony.detail].filter(Boolean).join(" ");
          let v3Label: string | null = null;
          if (data.conversation_id) {
            const { d: v3 } = await recordDialDisposition({
              dialKey: data.conversation_id,
              leadId: row[0].lead_id,
              campaignId: row[0].campaign_id,
              evidence: { callEnd, failureText, sipCode: telephony.sipStatusCode },
            });
            v3Label = v3.disposition;
            // Our-side refusals never reached the dealer: no touchpoint (see
            // advanceCampaign.recordTriggerVerdict).
            if (!v3.effects.carrierRefusal) await writeAiCallTouchpoint({
              v3,
              leadId: row[0].lead_id,
              provider: "elevenlabs",
              callId: data.conversation_id,
              transcript: null,
              providerStatus: "initiation_failed",
              callEndStatus: callEnd.status,
              callOutcome: outcome,
            });
          }
          const r = await completeCampaignLead({
            leadId: row[0].lead_id,
            status: callEnd.status,
            bolnaCallId: data.conversation_id,
            outcome,
            intentScore: null,
            campaignId: row[0].campaign_id,
            disposition: v3Label,
          });
          // AI dialer review — counted in the campaign's outcome report too.
          if (data.conversation_id) {
            await applyPostCall({
              provider: "elevenlabs",
              callId: data.conversation_id,
              leadId: row[0].lead_id,
              plan: await preparePostCall({
                callEnd,
                callOutcome: outcome,
                analysis: null,
                transcript: null,
                leadId: row[0].lead_id,
              }),
              callEnd,
              band: null,
              intentScore: null,
              summary: null,
              transcript: null,
              campaign: r,
            });
          }
          // Task 10 — an asynchronous refusal (SIP 503 etc. reported after
          // the trigger said OK) counts towards the carrier pause like a
          // synchronous one; a pause stops the advance.
          const pausedNow = r.campaignId
            ? await noteTriggerResult(r.campaignId, outcome)
            : false;
          if (r.campaignId && !pausedNow) {
            await advanceCampaign(r.campaignId, { preCallDelayMs: 5_000 });
          }
        }
      } catch (err) {
        console.error(
          "[elevenlabs:webhook] failed to advance after initiation failure:",
          err,
        );
      }
      return;
    }

    // Anything that is not a post-call transcription must not be finalized as
    // one. There was no default branch here, so an unknown or future event type
    // fell through into the path below and was recorded as a completed call
    // with an empty transcript — inventing a call that never happened.
    //
    // Read as a plain string on purpose: the declared union has been narrowed
    // to the transcription variant by the returns above, so TypeScript thinks
    // this is unreachable. The value arrives over the wire and is only as
    // narrow as ElevenLabs' API happens to be today.
    const eventType = (event as { type?: string }).type;
    if (eventType && eventType !== "post_call_transcription") {
      console.warn("[elevenlabs:webhook] unhandled event type:", eventType);
      return;
    }

    // Every stored field is derived in normalizePostCall.ts, which is pure and
    // unit-tested. The derivations that were wrong here — provider clock rather
    // than write time, real status rather than a hardcoded "completed", the
    // lead-id hint the payload always carried — belong somewhere they can be
    // asserted on.
    const call = normalizePostCall(event.data);

    // Task 10 — a carrier probe rang the team's own number. It is not a dealer
    // call: nothing to attribute, score or count.
    if (event.data.conversation_initiation_client_data?.dynamic_variables?.is_probe === "1") {
      console.log("[elevenlabs:webhook] carrier probe finished:", call.conversationId);
      return;
    }

    console.log("[ELEVENLABS WEBHOOK] Received:", {
      conversationId: call.conversationId,
      phone: call.phone,
      leadId: call.leadId,
      status: call.status,
      startedAt: call.startedAt?.toISOString() ?? null,
      hasTranscript: !!call.transcript,
      turns: event.data.transcript?.length ?? 0,
    });

    await finalizeElevenLabsCall({
      ...call,
      conversation: event.data.transcript || undefined,
    });
  } catch (err) {
    console.error("[elevenlabs:webhook] handler error:", err);
  }
}
