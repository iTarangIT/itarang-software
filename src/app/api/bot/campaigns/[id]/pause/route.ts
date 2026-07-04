// POST /api/bot/campaigns/[id]/pause
//
// Bot command: pause (stop) a running campaign. "Pause" maps to the CRM's stop
// semantics — drain in-flight 'calling' rows → 'failed', flip the campaign to
// status='stopped', and clear the Redis session if this campaign owns it. The
// queue's remaining 'pending' leads are preserved, so /resume can pick up where
// it left off.
//
// Mirrors /api/ai-dialer/campaigns/[id]/stop, attributing the stop to the
// Discord Bot service user.

import { db } from "@/lib/db";
import { dialerCampaigns } from "@/lib/db/schema";
import {
  drainActiveCampaignLeads,
  finalizeCampaign,
} from "@/lib/queue/campaignTracker";
import { dialerSession } from "@/lib/queue/dialerSession";
import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { DISCORD_BOT_USER_ID } from "@/lib/bot/constants";
import { eq } from "drizzle-orm";

export const POST = withBotAuth(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    const existing = await db
      .select({ id: dialerCampaigns.id, status: dialerCampaigns.status })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (existing.length === 0) return errorResponse("Campaign not found", 404);

    // Already-terminal campaigns short-circuit so a double-call doesn't
    // overwrite completed_at / stopped_by.
    if (existing[0].status !== "running") {
      return successResponse({
        campaignId,
        status: existing[0].status,
        alreadyTerminal: true,
      });
    }

    await drainActiveCampaignLeads(campaignId);
    await finalizeCampaign(campaignId, "stopped", DISCORD_BOT_USER_ID);

    try {
      const activeId = await dialerSession.getCampaignId();
      if (activeId && activeId === campaignId) {
        await dialerSession.stop();
      }
    } catch (err) {
      console.error("[bot.pause] dialerSession clear failed:", err);
    }

    return successResponse({ campaignId, status: "stopped" });
  },
);
