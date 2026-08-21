// Shared "launch a draft campaign" primitive. Both the List-upload start route
// (/api/ai-dialer/lists/[id]/start) and the Retry-failed route
// (/api/ai-dialer/campaigns/[id]/recall-failed) need the identical sequence:
// read the queue in order, flip the campaign to running, tag its leads with the
// chosen provider, seed the Redis dialer session, and place the first call via
// advanceCampaign (which refuses non-running campaigns — so status is set first).
//
// The caller is responsible for the lifecycle gate (only a draft should be
// started) and for capturing the result into its HTTP response.

import { db } from "@/lib/db";
import {
  dealerLeads,
  dialerCampaigns,
  dialerCampaignLeads,
} from "@/lib/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { dialerSession, type DialerProvider } from "./dialerSession";
import { advanceCampaign } from "./advanceCampaign";

export type StartCampaignResult = {
  // false when the campaign has no leads to dial — left untouched so the
  // caller can surface a 400 without having flipped it to running.
  started: boolean;
  queued: number;
  firstCallPlaced: boolean;
  firstCallError: string | null;
  // E-254 — the campaign was started outside its calling window, so
  // advanceCampaign parked it instead of dialing. This is a SUCCESS: the
  // campaign is armed and will run on its own. `armedStatus` is 'scheduled'
  // when it will auto-resume and 'paused' when it waits for a human.
  armed: boolean;
  armedStatus: "scheduled" | "paused" | null;
  resumeAt: Date | null;
};

export async function startDraftCampaign(
  campaignId: string,
  provider: DialerProvider,
  opts: { resetStartedAt?: boolean } = {},
): Promise<StartCampaignResult> {
  // Fresh starts stamp started_at = now. A retry-in-place keeps the campaign's
  // original start time (it's the same campaign, not a new run).
  const resetStartedAt = opts.resetStartedAt !== false;
  // The queue, in order. dialer_campaign_leads was populated at create time.
  const leadRows = await db
    .select({ lead_id: dialerCampaignLeads.lead_id })
    .from(dialerCampaignLeads)
    .where(eq(dialerCampaignLeads.campaign_id, campaignId))
    .orderBy(asc(dialerCampaignLeads.queue_position));
  const queueIds = leadRows.map((r) => r.lead_id);

  if (queueIds.length === 0) {
    return {
      started: false,
      queued: 0,
      firstCallPlaced: false,
      firstCallError: null,
      armed: false,
      armedStatus: null,
      resumeAt: null,
    };
  }

  // Flip to running BEFORE advanceCampaign (it refuses non-running campaigns),
  // recording the chosen provider + (for fresh starts) the real start time.
  await db
    .update(dialerCampaigns)
    .set({
      status: "running",
      provider,
      ...(resetStartedAt ? { started_at: new Date() } : {}),
    })
    .where(eq(dialerCampaigns.id, campaignId));

  // Tag leads with the provider so follow-ups + the catch-up cron route to the
  // right scheduler (mirrors /api/ai-dialer/start).
  try {
    const CHUNK = 500;
    for (let i = 0; i < queueIds.length; i += CHUNK) {
      await db
        .update(dealerLeads)
        .set({ provider })
        .where(inArray(dealerLeads.id, queueIds.slice(i, i + CHUNK)));
    }
  } catch (err) {
    console.error("[AI DIALER] startDraftCampaign: bulk-tag provider failed:", err);
  }

  await dialerSession.start(queueIds, { provider, campaignId });

  let firstCallPlaced = false;
  let firstCallError: string | null = null;
  let armed = false;
  let armedStatus: "scheduled" | "paused" | null = null;
  let resumeAt: Date | null = null;
  try {
    const r = await advanceCampaign(campaignId);
    firstCallPlaced = r.kind === "placed";
    if (r.kind === "error") firstCallError = r.error;
    // The window was shut. advanceCampaign has already flipped the campaign out
    // of 'running' — which is why this function needs no window logic of its
    // own, and why a manual resume outside business hours re-arms rather than
    // dialing: every start path lands here and inherits the same decision.
    if (r.kind === "window-closed") {
      armed = true;
      armedStatus = r.status;
      resumeAt = r.resumeAt;
    }
  } catch (err) {
    firstCallError = err instanceof Error ? err.message : "advance threw";
    console.error("[AI DIALER] startDraftCampaign → advanceCampaign failed:", err);
  }

  return {
    started: true,
    queued: queueIds.length,
    firstCallPlaced,
    firstCallError,
    armed,
    armedStatus,
    resumeAt,
  };
}
