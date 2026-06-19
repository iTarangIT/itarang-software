// GET /api/bot/campaigns/[id]/live-calls
//
// Bot command: the leads currently being dialed (dialer_campaign_leads.status =
// 'calling') for a campaign, joined to dealer_leads for display fields. Backs a
// Discord "who's on a call right now" view.

import { db } from "@/lib/db";
import { dialerCampaignLeads, dealerLeads } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { and, asc, eq } from "drizzle-orm";

const LIMIT = 100;

export const GET = withBotAuth(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    const rows = await db
      .select({
        leadId: dialerCampaignLeads.lead_id,
        bolnaCallId: dialerCampaignLeads.bolna_call_id,
        startedAt: dialerCampaignLeads.started_at,
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
          eq(dialerCampaignLeads.status, "calling"),
        ),
      )
      .orderBy(asc(dialerCampaignLeads.queue_position))
      .limit(LIMIT);

    return successResponse({ campaignId, count: rows.length, calls: rows });
  },
);
