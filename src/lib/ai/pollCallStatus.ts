// Provider-agnostic dialer poll. Reads all dialer_campaign_leads in
// 'calling' state that have a stored provider-call id, looks each up
// against the right provider's REST API, and runs the shared finalize
// pipeline when a call has reached a terminal state.
//
// Invoked from two places:
//   1. /api/cron/dialer-poll (Vercel cron, every minute in prod)
//   2. setInterval inside callWorker.ts (every 30s in dev, no Vercel cron)
//
// Idempotent: finalizeBolnaCall / finalizeElevenLabsCall both claim the
// call_id via Redis dedup, so a webhook racing with the poll is a no-op
// on whichever runs second.

import { db } from "@/lib/db";
import {
  dialerCampaignLeads,
  dialerCampaigns,
  dealerLeads,
} from "@/lib/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { getBolnaCallStatus } from "@/lib/ai/bolna_ai/getCallStatus";
import { getElevenLabsCallStatus } from "@/lib/ai/elevenlabs/getCallStatus";
import { finalizeBolnaCall } from "@/lib/ai/bolna_ai/finalizeCall";
import { finalizeElevenLabsCall } from "@/lib/ai/elevenlabs/finalizeCall";

export type DialerPollResult = {
  polled: number;
  finalized: number;
  skippedNotTerminal: number;
  errors: number;
  perRow: Array<{
    leadId: string;
    callId: string;
    provider: string;
    status: string;
    finalized: boolean;
    error?: string;
  }>;
};

const REQUEST_GAP_MS = 200; // be gentle on provider APIs
const MAX_ROWS_PER_TICK = 50;

export async function runDialerPollOnce(): Promise<DialerPollResult> {
  const rows = await db
    .select({
      campaignLeadId: dialerCampaignLeads.id,
      campaignId: dialerCampaignLeads.campaign_id,
      leadId: dialerCampaignLeads.lead_id,
      callId: dialerCampaignLeads.bolna_call_id,
      phone: dealerLeads.phone,
      provider: dialerCampaigns.provider,
    })
    .from(dialerCampaignLeads)
    .leftJoin(
      dealerLeads,
      eq(dealerLeads.id, dialerCampaignLeads.lead_id),
    )
    .leftJoin(
      dialerCampaigns,
      eq(dialerCampaigns.id, dialerCampaignLeads.campaign_id),
    )
    .where(
      and(
        eq(dialerCampaignLeads.status, "calling"),
        isNotNull(dialerCampaignLeads.bolna_call_id),
      ),
    )
    .limit(MAX_ROWS_PER_TICK);

  const result: DialerPollResult = {
    polled: rows.length,
    finalized: 0,
    skippedNotTerminal: 0,
    errors: 0,
    perRow: [],
  };

  for (const row of rows) {
    const provider = (row.provider || "bolna").toLowerCase();
    const callId = row.callId!;

    try {
      if (provider === "elevenlabs") {
        const s = await getElevenLabsCallStatus(callId);
        if (!s.success) {
          result.errors += 1;
          result.perRow.push({
            leadId: row.leadId,
            callId,
            provider,
            status: s.status,
            finalized: false,
            error: s.error,
          });
        } else if (!s.isTerminal) {
          result.skippedNotTerminal += 1;
          result.perRow.push({
            leadId: row.leadId,
            callId,
            provider,
            status: s.status,
            finalized: false,
          });
        } else {
          await finalizeElevenLabsCall({
            conversationId: callId,
            status: s.status,
            transcript: s.transcript,
            recordingUrl: s.recordingUrl,
            duration: s.duration,
            phone: s.phone ?? row.phone ?? null,
            leadId: row.leadId,
          });
          result.finalized += 1;
          result.perRow.push({
            leadId: row.leadId,
            callId,
            provider,
            status: s.status,
            finalized: true,
          });
        }
      } else {
        // Default + explicit "bolna"
        const s = await getBolnaCallStatus(callId);
        if (!s.success) {
          result.errors += 1;
          result.perRow.push({
            leadId: row.leadId,
            callId,
            provider,
            status: s.status,
            finalized: false,
            error: s.error,
          });
        } else if (!s.isTerminal) {
          result.skippedNotTerminal += 1;
          result.perRow.push({
            leadId: row.leadId,
            callId,
            provider,
            status: s.status,
            finalized: false,
          });
        } else {
          await finalizeBolnaCall({
            callId,
            status: s.status,
            transcript: s.transcript,
            recordingUrl: s.recordingUrl,
            duration: s.duration,
            phone: s.phone ?? row.phone ?? null,
            leadId: row.leadId,
            executionId: callId,
          });
          result.finalized += 1;
          result.perRow.push({
            leadId: row.leadId,
            callId,
            provider,
            status: s.status,
            finalized: true,
          });
        }
      }
    } catch (err) {
      result.errors += 1;
      result.perRow.push({
        leadId: row.leadId,
        callId,
        provider,
        status: "exception",
        finalized: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (REQUEST_GAP_MS > 0) {
      await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
    }
  }

  return result;
}
