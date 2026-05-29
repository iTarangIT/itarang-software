// GET /api/ai-dialer/campaigns/[id]
// Single-campaign detail. Used by the Campaign Detail page header for stats
// cards + region/segment chips + triggered-by name.

import { db } from "@/lib/db";
import { dialerCampaigns, users } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { eq } from "drizzle-orm";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (!id) return errorResponse("Campaign id required", 400);

    const rows = await db
      .select({
        id: dialerCampaigns.id,
        name: dialerCampaigns.name,
        status: dialerCampaigns.status,
        provider: dialerCampaigns.provider,
        category: dialerCampaigns.category,
        regionFilter: dialerCampaigns.region_filter,
        totalLeads: dialerCampaigns.total_leads,
        callsMade: dialerCampaigns.calls_made,
        completedLeads: dialerCampaigns.completed_leads,
        failedLeads: dialerCampaigns.failed_leads,
        startedAt: dialerCampaigns.started_at,
        completedAt: dialerCampaigns.completed_at,
        triggeredBy: dialerCampaigns.triggered_by,
        triggeredByName: users.name,
        stoppedBy: dialerCampaigns.stopped_by,
      })
      .from(dialerCampaigns)
      .leftJoin(users, eq(users.id, dialerCampaigns.triggered_by))
      .where(eq(dialerCampaigns.id, id))
      .limit(1);

    const campaign = rows[0];
    if (!campaign) return errorResponse("Campaign not found", 404);

    return successResponse(campaign);
  },
);
