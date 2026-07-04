// GET /api/bot/campaigns/[id]/status
//
// Bot command: single-campaign header stats (status, provider, counters,
// triggered-by name). For the per-bucket lead counts use /progress.
// Mirrors /api/ai-dialer/campaigns/[id].

import { db } from "@/lib/db";
import { dialerCampaigns, users } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { eq } from "drizzle-orm";

export const GET = withBotAuth(
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
        totalLeads: dialerCampaigns.total_leads,
        callsMade: dialerCampaigns.calls_made,
        completedLeads: dialerCampaigns.completed_leads,
        failedLeads: dialerCampaigns.failed_leads,
        startedAt: dialerCampaigns.started_at,
        completedAt: dialerCampaigns.completed_at,
        triggeredByName: users.name,
      })
      .from(dialerCampaigns)
      .leftJoin(users, eq(users.id, dialerCampaigns.triggered_by))
      .where(eq(dialerCampaigns.id, id))
      .limit(1);

    if (rows.length === 0) return errorResponse("Campaign not found", 404);
    return successResponse(rows[0]);
  },
);
