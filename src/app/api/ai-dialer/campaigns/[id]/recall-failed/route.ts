// POST /api/ai-dialer/campaigns/[id]/recall-failed
//
// "Retry failed leads": bundle this campaign's retryable failed leads into a
// BRAND-NEW campaign and start dialing it immediately. The source campaign and
// its stats are left completely untouched — each run stays a clean, separate
// record for audit/cost history.
//
// Retryable = dialer_campaign_leads.status='failed' EXCEPT the outcomes that
// can't or shouldn't be re-dialed:
//   - no_phone               → there is no number to call
//   - ineligible_active_lead → the lead is now owned by Inside Sales / ASM
//
// The new campaign carries recall:true in its region_filter, which makes
// advanceCampaign bypass the once-per-day idempotency guard so the second dial
// goes through even on the same day the lead first failed.

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { and, asc, eq, isNull, notInArray, or } from "drizzle-orm";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { type DialerProvider } from "@/lib/queue/dialerSession";
import { createCampaign } from "@/lib/queue/campaignTracker";
import { startDraftCampaign } from "@/lib/queue/startCampaign";

// Failure outcomes that should NOT be retried.
const NON_RETRYABLE_OUTCOMES = ["no_phone", "ineligible_active_lead"];

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    // Auth is best-effort (dev/system contexts) — same posture as list start.
    let triggeredBy: string | null = null;
    try {
      const user = await requireAuth();
      triggeredBy = user?.id ?? null;
    } catch {
      /* tolerate no session */
    }

    // Load the source campaign — we read from it but never mutate it.
    const rows = await db
      .select({
        id: dialerCampaigns.id,
        name: dialerCampaigns.name,
        status: dialerCampaigns.status,
        provider: dialerCampaigns.provider,
        category: dialerCampaigns.category,
        region_filter: dialerCampaigns.region_filter,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (rows.length === 0) return errorResponse("Campaign not found", 404);
    const source = rows[0];

    // Retrying while the source is still dialing would race its live session;
    // the UI hides the button in this state, but guard the API too.
    if (source.status === "running") {
      return errorResponse(
        "Wait for the campaign to finish before retrying.",
        400,
      );
    }

    // Retryable failed rows for the source campaign, in original queue order.
    const failed = await db
      .select({ lead_id: dialerCampaignLeads.lead_id })
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
      )
      .orderBy(asc(dialerCampaignLeads.queue_position));

    // De-dupe lead ids preserving order (a lead could have more than one
    // failed row across earlier follow-ups within the same campaign).
    const seen = new Set<string>();
    const queueIds: string[] = [];
    for (const r of failed) {
      if (!seen.has(r.lead_id)) {
        seen.add(r.lead_id);
        queueIds.push(r.lead_id);
      }
    }

    if (queueIds.length === 0) {
      return errorResponse("No failed leads to retry", 400);
    }

    // New campaign's region_filter: inherit the source region for display
    // context, then add the recall markers. recall:true is what makes
    // advanceCampaign bypass the once-per-day idempotency guard.
    const srcRegion =
      source.region_filter && typeof source.region_filter === "object"
        ? (source.region_filter as Record<string, unknown>)
        : {};
    const region = {
      ...srcRegion,
      recall: true,
      sourceCampaignId: source.id,
    };

    const provider: DialerProvider =
      source.provider === "elevenlabs" ? "elevenlabs" : "bolna";

    // Create the retry as a draft, then start it (same sequence as List start).
    const newId = await createCampaign({
      queueIds,
      provider,
      category: source.category,
      region,
      triggeredBy,
      status: "draft",
      name: `Retry · ${source.name}`,
    });

    if (!newId) return errorResponse("Could not create retry campaign", 500);

    // Flip to running, tag leads, seed the session, place the first call.
    const result = await startDraftCampaign(newId, provider);

    return successResponse({
      campaignId: newId,
      retryCount: queueIds.length,
      status: "running",
      firstCallPlaced: result.firstCallPlaced,
      firstCallError: result.firstCallError,
    });
  },
);
