// GET /api/bot/campaigns/[id]/progress
//
// Bot command: live progress of a campaign as per-bucket lead counts plus the
// parent header counters. Lightweight (single GROUP BY) — meant to back a
// Discord progress bar / embed, not to dump lead rows. Use /live-calls and
// /qualified for the actual lead lists.

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { eq, sql } from "drizzle-orm";

export const GET = withBotAuth(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    const header = await db
      .select({
        id: dialerCampaigns.id,
        status: dialerCampaigns.status,
        provider: dialerCampaigns.provider,
        totalLeads: dialerCampaigns.total_leads,
        callsMade: dialerCampaigns.calls_made,
        completedLeads: dialerCampaigns.completed_leads,
        failedLeads: dialerCampaigns.failed_leads,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (header.length === 0) return errorResponse("Campaign not found", 404);

    // Per-bucket counts straight off the queue table.
    const buckets = await db
      .select({
        status: dialerCampaignLeads.status,
        n: sql<number>`count(*)::int`,
      })
      .from(dialerCampaignLeads)
      .where(eq(dialerCampaignLeads.campaign_id, campaignId))
      .groupBy(dialerCampaignLeads.status);

    const counts = { pending: 0, calling: 0, completed: 0, failed: 0 };
    for (const b of buckets) {
      if (b.status && b.status in counts) {
        counts[b.status as keyof typeof counts] = Number(b.n);
      }
    }

    const total = header[0].totalLeads ?? 0;
    const done = counts.completed + counts.failed;
    const percentComplete =
      total > 0 ? Math.round((done / total) * 100) : 0;

    return successResponse({
      campaignId,
      status: header[0].status,
      provider: header[0].provider,
      total,
      counts,
      callsMade: header[0].callsMade,
      percentComplete,
    });
  },
);
