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
import type {
  ElevenLabsWebhookEvent,
  ElevenLabsTranscriptTurn,
} from "./types";

function transcriptArrayToString(turns?: ElevenLabsTranscriptTurn[]): string {
  if (!Array.isArray(turns) || turns.length === 0) return "";
  return turns
    .map((t) => {
      const role = (t.role || "").toLowerCase();
      const speaker =
        role === "user" ? "user" : role === "agent" ? "agent" : role;
      const message = (t.message || "").trim();
      return message ? `${speaker}: ${message}` : "";
    })
    .filter(Boolean)
    .join("\n");
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
          .where(eq(dialerCampaignLeads.bolna_call_id, data.conversation_id))
          .limit(1);
        if (row[0]) {
          const r = await completeCampaignLead({
            leadId: row[0].lead_id,
            success: false,
            bolnaCallId: data.conversation_id,
            outcome: data.failure_reason ?? "initiation_failed",
            intentScore: null,
            campaignId: row[0].campaign_id,
          });
          if (r.campaignId) {
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

    // post_call_transcription
    const data = event.data;
    const conversationId = data.conversation_id;
    const transcript = transcriptArrayToString(data.transcript);
    const phone =
      data.metadata?.phone_call?.external_number ||
      (data.conversation_initiation_client_data?.dynamic_variables
        ?.phone_number as string | undefined) ||
      "";
    const recordingUrl =
      (data.metadata as { recording_url?: string | null } | undefined)
        ?.recording_url ?? null;
    const duration =
      typeof (data.metadata as { call_duration_secs?: number } | undefined)
        ?.call_duration_secs === "number"
        ? (data.metadata as { call_duration_secs: number }).call_duration_secs
        : null;

    console.log("[ELEVENLABS WEBHOOK] Received:", {
      conversationId,
      phone,
      hasTranscript: !!transcript,
      turns: data.transcript?.length ?? 0,
    });

    await finalizeElevenLabsCall({
      conversationId,
      status: "completed",
      transcript: transcript || null,
      recordingUrl,
      duration,
      phone: phone || null,
      conversation: data.transcript || undefined,
    });
  } catch (err) {
    console.error("[elevenlabs:webhook] handler error:", err);
  }
}
