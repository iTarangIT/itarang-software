// POST /api/bot/campaigns/[id]/retry-failed
//
// Bot command: bundle this campaign's retryable failed leads into a BRAND-NEW
// campaign (owned by the Discord Bot service user) and start dialing it. The
// source campaign is left untouched so each run stays a clean audit record.
//
// Retryable = dialer_campaign_leads.status='failed' EXCEPT no_phone /
// ineligible_active_lead. The new campaign carries recall:true in region_filter
// so advanceCampaign bypasses the once-per-day idempotency guard.
//
// Mirrors /api/ai-dialer/campaigns/[id]/recall-failed.

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { and, asc, eq, isNull, notInArray, or } from "drizzle-orm";
import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { DISCORD_BOT_USER_ID, BOT_CAMPAIGN_SOURCE } from "@/lib/bot/constants";
import { type DialerProvider } from "@/lib/queue/dialerSession";
import { createCampaign } from "@/lib/queue/campaignTracker";
import { startDraftCampaign } from "@/lib/queue/startCampaign";

const NON_RETRYABLE_OUTCOMES = ["no_phone", "ineligible_active_lead"];

export const POST = withBotAuth(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

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

    // Retrying while the source is still dialing would race its live session.
    if (source.status === "running") {
      return errorResponse("Wait for the campaign to finish before retrying.", 400);
    }

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

    // De-dupe lead ids preserving order.
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

    const srcRegion =
      source.region_filter && typeof source.region_filter === "object"
        ? (source.region_filter as Record<string, unknown>)
        : {};
    const region = {
      ...srcRegion,
      source: BOT_CAMPAIGN_SOURCE,
      recall: true,
      sourceCampaignId: source.id,
    };

    const provider: DialerProvider =
      source.provider === "elevenlabs" ? "elevenlabs" : "bolna";

    const baseName = (source.name ?? "").replace(/^(?:Retry · )+/, "").trim();
    const retryName = `Retry · ${baseName || "previous campaign"}`;

    const newId = await createCampaign({
      queueIds,
      provider,
      category: source.category,
      region,
      triggeredBy: DISCORD_BOT_USER_ID,
      status: "draft",
      name: retryName,
    });

    if (!newId) return errorResponse("Could not create retry campaign", 500);

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
