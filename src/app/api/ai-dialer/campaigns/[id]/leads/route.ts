// GET /api/ai-dialer/campaigns/[id]/leads?bucket=all|pending|calling|completed|failed&page=N
//
// Drives both:
//   1. The expanded AI dialer banner (bucket=all → returns three columns)
//   2. The Campaign Detail page lead table (specific bucket, paginated)
//
// All leads in a campaign are JOIN'd back to dealer_leads for display fields
// (shop_name, dealer_name, phone, score). Soft FK — no DB constraint, so a
// LEFT JOIN handles the case where a lead row was deleted post-campaign.

import { db } from "@/lib/db";
import { dialerCampaignLeads, dealerLeads } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

const PAGE_SIZE = 50;
const BANNER_LIMIT = 100; // per bucket on bucket=all

const VALID_BUCKETS = new Set([
  "all",
  "pending",
  "calling",
  "completed",
  "failed",
  "skipped",
]);

function shapeRow(r: any) {
  return {
    id: r.id,
    leadId: r.leadId,
    queuePosition: r.queuePosition,
    status: r.status,
    callOutcome: r.callOutcome,
    intentScore: r.intentScore,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    shopName: r.shopName,
    dealerName: r.dealerName,
    phone: r.phone,
    city: r.city,
    state: r.state,
    finalIntentScore: r.finalIntentScore,
    currentStatus: r.currentStatus,
  };
}

const selectShape = {
  id: dialerCampaignLeads.id,
  leadId: dialerCampaignLeads.lead_id,
  queuePosition: dialerCampaignLeads.queue_position,
  status: dialerCampaignLeads.status,
  callOutcome: dialerCampaignLeads.call_outcome,
  intentScore: dialerCampaignLeads.intent_score,
  startedAt: dialerCampaignLeads.started_at,
  completedAt: dialerCampaignLeads.completed_at,
  shopName: dealerLeads.shop_name,
  dealerName: dealerLeads.dealer_name,
  phone: dealerLeads.phone,
  city: dealerLeads.city,
  state: dealerLeads.state,
  finalIntentScore: dealerLeads.final_intent_score,
  currentStatus: dealerLeads.current_status,
};

export const GET = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    const { searchParams } = new URL(req.url);
    const bucket = (searchParams.get("bucket") || "all").toLowerCase();
    const page = Math.max(1, Number(searchParams.get("page") || 1));

    if (!VALID_BUCKETS.has(bucket)) {
      return errorResponse(`Invalid bucket: ${bucket}`, 400);
    }

    // bucket=all returns three buckets in one round-trip for the banner.
    if (bucket === "all") {
      const [pending, calling, completed, failed] = await Promise.all([
        db
          .select(selectShape)
          .from(dialerCampaignLeads)
          .leftJoin(
            dealerLeads,
            eq(dealerLeads.id, dialerCampaignLeads.lead_id),
          )
          .where(
            and(
              eq(dialerCampaignLeads.campaign_id, campaignId),
              eq(dialerCampaignLeads.status, "pending"),
            ),
          )
          .orderBy(asc(dialerCampaignLeads.queue_position))
          .limit(BANNER_LIMIT),
        db
          .select(selectShape)
          .from(dialerCampaignLeads)
          .leftJoin(
            dealerLeads,
            eq(dealerLeads.id, dialerCampaignLeads.lead_id),
          )
          .where(
            and(
              eq(dialerCampaignLeads.campaign_id, campaignId),
              eq(dialerCampaignLeads.status, "calling"),
            ),
          )
          .orderBy(asc(dialerCampaignLeads.queue_position))
          .limit(BANNER_LIMIT),
        db
          .select(selectShape)
          .from(dialerCampaignLeads)
          .leftJoin(
            dealerLeads,
            eq(dealerLeads.id, dialerCampaignLeads.lead_id),
          )
          .where(
            and(
              eq(dialerCampaignLeads.campaign_id, campaignId),
              eq(dialerCampaignLeads.status, "completed"),
            ),
          )
          .orderBy(desc(dialerCampaignLeads.completed_at))
          .limit(BANNER_LIMIT),
        db
          .select(selectShape)
          .from(dialerCampaignLeads)
          .leftJoin(
            dealerLeads,
            eq(dealerLeads.id, dialerCampaignLeads.lead_id),
          )
          .where(
            and(
              eq(dialerCampaignLeads.campaign_id, campaignId),
              eq(dialerCampaignLeads.status, "failed"),
            ),
          )
          .orderBy(desc(dialerCampaignLeads.completed_at))
          .limit(BANNER_LIMIT),
      ]);

      return successResponse({
        pending: pending.map(shapeRow),
        calling: calling.map(shapeRow),
        completed: completed.map(shapeRow),
        failed: failed.map(shapeRow),
      });
    }

    // Single-bucket paginated list for the detail page.
    const offset = (page - 1) * PAGE_SIZE;
    const orderClause =
      bucket === "pending" || bucket === "calling"
        ? asc(dialerCampaignLeads.queue_position)
        : desc(dialerCampaignLeads.completed_at);

    const where =
      bucket === "all"
        ? eq(dialerCampaignLeads.campaign_id, campaignId)
        : and(
            eq(dialerCampaignLeads.campaign_id, campaignId),
            inArray(dialerCampaignLeads.status, [bucket]),
          );

    const rows = await db
      .select(selectShape)
      .from(dialerCampaignLeads)
      .leftJoin(dealerLeads, eq(dealerLeads.id, dialerCampaignLeads.lead_id))
      .where(where)
      .orderBy(orderClause)
      .limit(PAGE_SIZE)
      .offset(offset);

    return successResponse({
      data: rows.map(shapeRow),
      page,
      pageSize: PAGE_SIZE,
    });
  },
);
