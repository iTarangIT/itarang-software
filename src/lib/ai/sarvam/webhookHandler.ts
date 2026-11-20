// Sarvam call-end webhook → the shared post-call pipeline.
//
// Sarvam posts once per attempt, connected or not.
//   - no_answer / busy / failed take the same path as an ElevenLabs
//     call_initiation_failure: classify, complete the campaign lead, record the
//     disposition, advance the campaign.
//   - connected is normalized and handed to finalizeElevenLabsCall with
//     provider "sarvam", so it runs the CRM's own transcript analysis, writes
//     ai_call_logs, the lead timeline and the disposition, then advances.

import { db } from "@/lib/db";
import { dialerCampaignLeads } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { finalizeElevenLabsCall } from "@/lib/ai/elevenlabs/finalizeCall";
import { claimCallForProcessing } from "@/lib/ai/analysis/callClaim";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { completeCampaignLead } from "@/lib/queue/campaignTracker";
import { classifyCallEnd } from "@/lib/ai-dialer/campaignLeadStatus";
import { applyPostCall, preparePostCall } from "@/lib/ai-dialer/postCallOutcome";
import { sarvamAppId } from "./config";
import { resolveSarvamRecording } from "./fetchRecording";
import {
  isSarvamConnected,
  normalizeSarvamWebhook,
  sarvamNotConnectedEvidence,
} from "./normalizeWebhook";
import type { SarvamWebhookPayload } from "./types";

/** The campaign-lead row this attempt belongs to. */
async function findCampaignRow(attemptId: string, leadId: string | undefined) {
  const byCallId = await db
    .select({
      id: dialerCampaignLeads.id,
      lead_id: dialerCampaignLeads.lead_id,
      campaign_id: dialerCampaignLeads.campaign_id,
    })
    .from(dialerCampaignLeads)
    .where(eq(dialerCampaignLeads.bolna_call_id, attemptId))
    .limit(1);
  if (byCallId[0]) return byCallId[0];

  // A webhook that beats attachBolnaCallId (a very fast no-answer) — fall back
  // to the lead's row that is still `calling`.
  if (!leadId) return null;
  const calling = await db
    .select({
      id: dialerCampaignLeads.id,
      lead_id: dialerCampaignLeads.lead_id,
      campaign_id: dialerCampaignLeads.campaign_id,
    })
    .from(dialerCampaignLeads)
    .where(
      and(
        eq(dialerCampaignLeads.lead_id, leadId),
        eq(dialerCampaignLeads.status, "calling"),
      ),
    )
    .orderBy(desc(dialerCampaignLeads.created_at))
    .limit(1);
  return calling[0] ?? null;
}

async function handleNotConnected(payload: SarvamWebhookPayload) {
  const attemptId = payload.attempt_id;
  const metaLeadId =
    typeof payload.webhook_config?.metadata?.lead_id === "string"
      ? payload.webhook_config.metadata.lead_id
      : undefined;

  const claimed = await claimCallForProcessing("sarvam", attemptId);
  if (!claimed) {
    console.log("[sarvam:webhook] already processed:", attemptId);
    return;
  }

  const row = await findCampaignRow(attemptId, metaLeadId);
  if (!row) {
    console.warn("[sarvam:webhook] no campaign row for not-connected attempt", {
      attemptId,
      leadId: metaLeadId,
      status: payload.status,
    });
    return;
  }

  const evidence = sarvamNotConnectedEvidence(payload);
  const callEnd = classifyCallEnd({
    providerStatus: evidence.providerStatus,
    initiationFailureReason: evidence.initiationFailureReason,
  });

  const r = await completeCampaignLead({
    leadId: row.lead_id,
    status: callEnd.status,
    bolnaCallId: attemptId,
    outcome: callEnd.outcome ?? evidence.outcome,
    intentScore: null,
    campaignId: row.campaign_id,
  });

  await applyPostCall({
    provider: "sarvam",
    callId: attemptId,
    leadId: row.lead_id,
    plan: await preparePostCall({
      callEnd,
      callOutcome: evidence.outcome,
      analysis: null,
      transcript: null,
      leadId: row.lead_id,
    }),
    callEnd,
    band: null,
    intentScore: null,
    summary: null,
    transcript: null,
    campaign: r,
  });

  if (r.campaignId) {
    await advanceCampaign(r.campaignId, { preCallDelayMs: 5_000 });
  }
}

export async function handleSarvamWebhook(
  payload: SarvamWebhookPayload,
  receivedAt: Date = new Date(),
): Promise<void> {
  try {
    if (!payload || typeof payload.attempt_id !== "string" || !payload.attempt_id) {
      console.warn("[sarvam:webhook] payload without attempt_id — ignored");
      return;
    }

    if (!isSarvamConnected(payload.status)) {
      console.log("[sarvam:webhook] not connected:", {
        attemptId: payload.attempt_id,
        status: payload.status,
        reason: payload.failure_reason,
      });
      await handleNotConnected(payload);
      return;
    }

    const call = normalizeSarvamWebhook(payload, { receivedAt, appId: sarvamAppId() });
    const recordingUrl = await resolveSarvamRecording(call.conversationId, call.interactionId);

    console.log("[sarvam:webhook] connected:", {
      attemptId: call.conversationId,
      leadId: call.leadId,
      duration: call.duration,
      turns: call.conversation?.length ?? 0,
      answeredBy: call.answeredBy,
      callResult: call.callResult,
      callbackAgreed: call.callbackAgreed,
      // Sarvam's own scoring — a second opinion only; the CRM scores the
      // transcript itself in finalize.
      sarvam: call.providerExtras,
      hasRecording: !!recordingUrl,
      // Unverified point 1: are the post-call variables present at webhook time?
      agentVariables: Object.keys(payload.final_agent_variables ?? {}).length,
    });

    await finalizeElevenLabsCall({
      provider: "sarvam",
      conversationId: call.conversationId,
      status: call.status,
      transcript: call.transcript,
      recordingUrl,
      duration: call.duration,
      phone: call.phone,
      leadId: call.leadId,
      conversation: call.conversation,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      agentId: call.agentId,
      terminationReason: call.terminationReason,
      answeredBy: call.answeredBy,
      callResult: call.callResult,
      callLanguage: call.callLanguage,
      callbackAgreed: call.callbackAgreed,
    });
  } catch (err) {
    console.error("[sarvam:webhook] handler error:", err);
  }
}
