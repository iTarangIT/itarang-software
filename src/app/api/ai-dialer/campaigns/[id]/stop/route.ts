// POST /api/ai-dialer/campaigns/[id]/stop
//
// Force-stop a running campaign from the Campaign Detail page. Two things
// happen:
//
//   1. Drain in-flight 'calling' rows → 'failed' (drainActiveCampaignLeads)
//      and the parent counters are bumped accordingly.
//   2. Flip the campaign row to status='stopped'.
//
// If this campaign owns the live Redis dialer session, also clear it so the
// /status poller stops trying to advance into a dead campaign.
//
// Late-arriving webhooks for this campaign remain harmless — completeCampaignLead
// only matches rows IN ('pending','calling'), which after the drain is the
// empty set.

import { db } from "@/lib/db";
import { dialerCampaigns } from "@/lib/db/schema";
import {
  drainActiveCampaignLeads,
  finalizeCampaign,
} from "@/lib/queue/campaignTracker";
import { dialerSession } from "@/lib/queue/dialerSession";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { CAMPAIGN_ACTION_ROLES } from "@/lib/leads/access";
import { eq } from "drizzle-orm";

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    // asm / inside_sales_rep may view a campaign but not drive it.
    const user = await requireRole([...CAMPAIGN_ACTION_ROLES]);
    const stoppedBy: string | null = user?.id ?? null;

    const existing = await db
      .select({
        id: dialerCampaigns.id,
        status: dialerCampaigns.status,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (existing.length === 0) {
      return errorResponse("Campaign not found", 404);
    }

    // Already-terminal campaigns short-circuit so a double-click doesn't
    // overwrite completed_at or stoppedBy.
    if (existing[0].status !== "running") {
      return successResponse({
        campaignId,
        status: existing[0].status,
        alreadyTerminal: true,
      });
    }

    await drainActiveCampaignLeads(campaignId);
    await finalizeCampaign(campaignId, "stopped", stoppedBy);

    // If the Redis session belongs to this campaign, clear it so the dialer
    // banner and /status poller stop trying to step the queue forward.
    try {
      const activeId = await dialerSession.getCampaignId();
      if (activeId && activeId === campaignId) {
        await dialerSession.stop();
      }
    } catch (err) {
      console.error("[campaign.stop] dialerSession clear failed:", err);
    }

    return successResponse({ campaignId, status: "stopped" });
  },
);
