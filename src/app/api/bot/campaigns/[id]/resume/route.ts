// POST /api/bot/campaigns/[id]/resume
//
// Bot command: resume a *paused* (stopped) campaign and keep dialing the leads
// that were never reached. Reuses startDraftCampaign with resetStartedAt:false
// so the original started_at is preserved (same run). advanceCampaign claims
// only status='pending' rows (FOR UPDATE SKIP LOCKED), so completed/failed
// leads are never re-dialed.
//
// Mirrors /api/ai-dialer/campaigns/[id]/resume.

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { startDraftCampaign } from "@/lib/queue/startCampaign";
import type { DialerProvider } from "@/lib/queue/dialerSession";
import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { and, eq, sql } from "drizzle-orm";

export const POST = withBotAuth(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    const existing = await db
      .select({
        id: dialerCampaigns.id,
        status: dialerCampaigns.status,
        provider: dialerCampaigns.provider,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (existing.length === 0) return errorResponse("Campaign not found", 404);
    const campaign = existing[0];

    // Already-running short-circuits so a double-call doesn't seed a second
    // session / place a duplicate first call.
    if (campaign.status === "running") {
      return successResponse({
        campaignId,
        status: campaign.status,
        alreadyRunning: true,
      });
    }

    // Only a paused (stopped) campaign can be resumed.
    if (campaign.status !== "stopped") {
      return errorResponse(`Cannot resume a ${campaign.status} campaign`, 400);
    }

    const pendingRes = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(dialerCampaignLeads)
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.status, "pending"),
        ),
      );
    if ((pendingRes[0]?.n ?? 0) === 0) {
      return errorResponse("No pending leads to resume", 400);
    }

    const result = await startDraftCampaign(
      campaignId,
      campaign.provider as DialerProvider,
      { resetStartedAt: false },
    );

    return successResponse({
      campaignId,
      status: "running",
      queued: result.queued,
      firstCallPlaced: result.firstCallPlaced,
      firstCallError: result.firstCallError,
    });
  },
);
