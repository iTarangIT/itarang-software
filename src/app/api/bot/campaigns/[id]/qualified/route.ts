// GET /api/bot/campaigns/[id]/qualified
//
// Bot command: leads from a campaign whose AI call qualified them — completed
// calls with intent_score >= INTENT_THRESHOLDS.QUALIFIED (75, the same bar the
// CRM uses for "qualified"). Joined to dealer_leads for display + sorted by
// score so the hottest leads surface first in Discord.

import { db } from "@/lib/db";
import { dialerCampaignLeads, dealerLeads } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { INTENT_THRESHOLDS } from "@/lib/ai/scoring";
import { and, desc, eq, gte } from "drizzle-orm";

const LIMIT = 200;

export const GET = withBotAuth(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    const rows = await db
      .select({
        leadId: dialerCampaignLeads.lead_id,
        intentScore: dialerCampaignLeads.intent_score,
        callOutcome: dialerCampaignLeads.call_outcome,
        completedAt: dialerCampaignLeads.completed_at,
        dealerName: dealerLeads.dealer_name,
        shopName: dealerLeads.shop_name,
        phone: dealerLeads.phone,
        city: dealerLeads.city,
        state: dealerLeads.state,
      })
      .from(dialerCampaignLeads)
      .leftJoin(dealerLeads, eq(dealerLeads.id, dialerCampaignLeads.lead_id))
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.status, "completed"),
          gte(dialerCampaignLeads.intent_score, INTENT_THRESHOLDS.QUALIFIED),
        ),
      )
      .orderBy(desc(dialerCampaignLeads.intent_score))
      .limit(LIMIT);

    return successResponse({
      campaignId,
      threshold: INTENT_THRESHOLDS.QUALIFIED,
      count: rows.length,
      qualified: rows,
    });
  },
);
