// POST /api/ai-dialer/campaigns/[id]/recall-failed
//
// "Retry failed leads": re-dial this campaign's retryable failed leads IN PLACE
// — no new campaign is created. The failed rows are reset to 'pending', the
// campaign is rolled back to 'running', and dialing resumes via advanceCampaign.
//
// Retryable = dialer_campaign_leads.status='failed' EXCEPT the outcomes that
// can't or shouldn't be re-dialed:
//   - no_phone               → there is no number to call
//   - ineligible_active_lead → the lead is now owned by Inside Sales / ASM
//
// A `recall: true` marker is merged into the campaign's region_filter, which
// makes advanceCampaign bypass the once-per-day idempotency guard so the second
// dial goes through even on the same day the lead first failed.

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { type DialerProvider } from "@/lib/queue/dialerSession";
import { startDraftCampaign } from "@/lib/queue/startCampaign";

// Failure outcomes that should NOT be retried.
const NON_RETRYABLE_OUTCOMES = ["no_phone", "ineligible_active_lead"];

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    // Auth is best-effort (dev/system contexts) — same posture as list start.
    try {
      await requireAuth();
    } catch {
      /* tolerate no session */
    }

    const rows = await db
      .select({
        id: dialerCampaigns.id,
        status: dialerCampaigns.status,
        provider: dialerCampaigns.provider,
        region_filter: dialerCampaigns.region_filter,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (rows.length === 0) return errorResponse("Campaign not found", 404);
    const campaign = rows[0];

    if (campaign.status === "running") {
      return errorResponse("Campaign is already running", 400);
    }

    // Retryable failed rows for this campaign.
    const failed = await db
      .select({ id: dialerCampaignLeads.id })
      .from(dialerCampaignLeads)
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.status, "failed"),
          or(
            isNull(dialerCampaignLeads.call_outcome),
            notInArray(dialerCampaignLeads.call_outcome, NON_RETRYABLE_OUTCOMES),
          ),
        ),
      );

    if (failed.length === 0) {
      return errorResponse("No failed leads to retry", 400);
    }

    const rowIds = failed.map((r) => r.id);
    const n = rowIds.length;

    // 1. Reset the failed rows to a fresh 'pending' so advanceCampaign re-dials
    //    them, clearing the prior attempt's outcome / timestamps / call id.
    const CHUNK = 500;
    for (let i = 0; i < rowIds.length; i += CHUNK) {
      await db
        .update(dialerCampaignLeads)
        .set({
          status: "pending",
          call_outcome: null,
          started_at: null,
          completed_at: null,
          bolna_call_id: null,
          intent_score: null,
        })
        .where(inArray(dialerCampaignLeads.id, rowIds.slice(i, i + CHUNK)));
    }

    // 2. Roll the campaign back to a runnable state: drop the just-un-failed
    //    rows from failed_leads, clear the terminal markers, and stamp the
    //    region_filter so the dialer bypasses the same-day idempotency guard.
    const existingRegion =
      campaign.region_filter && typeof campaign.region_filter === "object"
        ? (campaign.region_filter as Record<string, unknown>)
        : {};
    await db
      .update(dialerCampaigns)
      .set({
        completed_at: null,
        stopped_by: null,
        failed_leads: sql`GREATEST(${dialerCampaigns.failed_leads} - ${n}, 0)`,
        region_filter: { ...existingRegion, recall: true },
      })
      .where(eq(dialerCampaigns.id, campaignId));

    // 3. Resume dialing — flips status→running, seeds the session, places the
    //    first call. Preserve the original started_at (same campaign, not a new run).
    const provider: DialerProvider =
      campaign.provider === "elevenlabs" ? "elevenlabs" : "bolna";
    const result = await startDraftCampaign(campaignId, provider, {
      resetStartedAt: false,
    });

    return successResponse({
      campaignId,
      retryCount: n,
      status: "running",
      firstCallPlaced: result.firstCallPlaced,
      firstCallError: result.firstCallError,
    });
  },
);
