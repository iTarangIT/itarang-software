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
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { INTENT_THRESHOLDS } from "@/lib/ai/scoring";

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

// Authoritative call duration in seconds: the provider-reported value when
// present, else wall-clock (completed − started) clamped to a sane window.
// Mirrors transcript/route.ts so the table and the drawer always agree.
function deriveDuration(
  callDuration: number | string | null | undefined,
  startedAt: Date | string | null,
  completedAt: Date | string | null,
): number | null {
  const provided = callDuration != null ? Number(callDuration) : null;
  if (provided != null && Number.isFinite(provided) && provided > 0) {
    return provided;
  }
  if (startedAt && completedAt) {
    const diffSec = Math.round(
      (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
    );
    if (diffSec > 0 && diffSec < 2 * 60 * 60) return diffSec;
  }
  return null;
}

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
    // Exact call duration (seconds) shown in the table's Duration column.
    durationSeconds: deriveDuration(r.callDuration, r.startedAt, r.completedAt),
    // True when a reviewer has manually corrected this lead's intent score.
    corrected: Boolean(r.corrected),
    // Cross-campaign attempt tracking (only populated on the detail query).
    attemptCount: Number(r.attemptCount ?? 0),
    convertedOnAttempt:
      r.convertedOnAttempt != null ? Number(r.convertedOnAttempt) : null,
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
  // Provider-reported duration of THIS attempt's call (ai_call_logs.call_duration,
  // keyed by the campaign-lead's bolna_call_id). Same source as the drawer; the
  // wall-clock fallback is applied in shapeRow. Raw table name keeps the
  // subquery off the JOIN, matching the attemptCount/convertedOnAttempt pattern.
  callDuration: sql<number | null>`(
    select call_duration from ai_call_logs
    where call_id = ${dialerCampaignLeads.bolna_call_id}
    limit 1
  )`,
  // Whether a human has corrected this lead's intent score in any attempt
  // (intent_score_feedback, E-159). Lead-level — drives the "Corrected" flag.
  corrected: sql<boolean>`exists (
    select 1 from intent_score_feedback f
    where f.lead_id = ${dialerCampaignLeads.lead_id}
  )`,
};

// Detail-table only: the lead's total dialer attempts across ALL campaigns
// (original + every recall), and the 1-based attempt on which it first crossed
// the qualified-intent threshold (75 — matches getLeadStatus() in
// src/lib/ai/storage/leadStore.ts). Computed as correlated subqueries so the
// per-row cost stays on the campaign-detail table and off the lighter
// bucket=all banner query, which doesn't render these columns.
const detailSelectShape = {
  ...selectShape,
  attemptCount: sql<number>`(
    select count(*)::int from dialer_campaign_leads x
    where x.lead_id = ${dialerCampaignLeads.lead_id}
  )`,
  convertedOnAttempt: sql<number | null>`(
    select s.ord::int from (
      select row_number() over (
               order by c.started_at asc nulls last, x.created_at asc
             ) as ord,
             x.intent_score as sc
      from dialer_campaign_leads x
      join dialer_campaigns c on c.id = x.campaign_id
      where x.lead_id = ${dialerCampaignLeads.lead_id}
    ) s
    where s.sc >= ${INTENT_THRESHOLDS.QUALIFIED}
    order by s.ord asc
    limit 1
  )`,
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
      .select(detailSelectShape)
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
