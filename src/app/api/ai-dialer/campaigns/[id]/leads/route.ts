// GET /api/ai-dialer/campaigns/[id]/leads?bucket=all|pending|calling|completed|failed&page=N
//
// Drives both:
//   1. The expanded AI dialer banner (bucket=all → returns three columns)
//   2. The Campaign Detail page lead table (specific bucket, paginated)
//
// All leads in a campaign are JOIN'd back to dealer_leads for display fields
// (shop_name, dealer_name, phone, score). Soft FK — no DB constraint, so a
// LEFT JOIN handles the case where a lead row was deleted post-campaign.

import { deriveFailureReason } from "@/lib/ai-dialer/failureReason";
import { db } from "@/lib/db";
import { dialerCampaignLeads, dealerLeads } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { INTENT_THRESHOLDS } from "@/lib/ai/scoring";
import {
  correlatedDurationSeconds,
  deriveDurationSeconds,
} from "@/lib/ai-dialer/call-duration/derive";
import { resolveDurationBucketConfig } from "@/lib/ai-dialer/call-duration/config-store";

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

// Call duration now lives in @/lib/ai-dialer/call-duration/derive, alongside
// its SQL twin. It used to be a local copy here and a byte-identical second
// copy in transcript/route.ts, whose comment promised the two "always agree" —
// importing the one rule is what makes that true rather than aspirational, and
// it is the same expression the duration histogram bins by.

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
    // `hasTranscript` gates the wall-clock fallback: the started/completed pair
    // brackets the DIALER's attempt, so without that gate a trigger_failed row
    // shows the seconds we spent failing to place the call as its duration.
    durationSeconds: deriveDurationSeconds(
      r.callDuration,
      r.startedAt,
      r.completedAt,
      r.hasTranscript,
    ),
    // True when a reviewer has manually corrected this lead's intent score.
    corrected: Boolean(r.corrected),
    // Why this call produced no conversation, in words the sales team can act
    // on — null when it succeeded. Derived server-side so the table, the export
    // and the retry filter can never disagree about what happened.
    failureReason: deriveFailureReason({
      status: r.status,
      callOutcome: r.callOutcome,
      hasTranscript: r.hasTranscript,
      providerStatus: r.logStatus,
      bandCallStatus: r.logCallStatus,
    }),
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
  // The evidence behind the failure reason. Same correlated-subquery pattern as
  // callDuration above, on the same already-indexed ai_call_logs.call_id.
  //
  // hasTranscript is the important one: it OUTRANKS call_outcome, because a
  // transcript is proof the call happened. That is how a row could read
  // "Trigger failed" while its own drawer played back a recording.
  hasTranscript: sql<boolean>`(
    select transcript is not null from ai_call_logs
    where call_id = ${dialerCampaignLeads.bolna_call_id}
    limit 1
  )`,
  logStatus: sql<string | null>`(
    select status from ai_call_logs
    where call_id = ${dialerCampaignLeads.bolna_call_id}
    limit 1
  )`,
  logCallStatus: sql<string | null>`(
    select call_status from ai_call_logs
    where call_id = ${dialerCampaignLeads.bolna_call_id}
    limit 1
  )`,
  // Whether a human has corrected this lead's intent score in any attempt
  // (intent_score_feedback, E-159). Lead-level — drives the "Corrected" flag.
  //
  // E-250: excludes rows imported from the retired Campaign_Call_Review sheet
  // whose free text named no band. Those are preserved as commentary, not
  // verdicts, and lighting a "Corrected" pill for them would claim a decision
  // nobody made.
  //
  // Filters on corrected_status rather than the more obvious review_kind on
  // purpose: review_kind is an E-250 column, and naming it here would make this
  // whole query — and with it the campaign leads table — fail with a 42703 on
  // any database where E-250 has not been applied yet. corrected_status has
  // existed since E-159, and the importer writes the 'none' sentinel into it
  // for exactly this reason.
  corrected: sql<boolean>`exists (
    select 1 from intent_score_feedback f
    where f.lead_id = ${dialerCampaignLeads.lead_id}
      and f.corrected_status <> 'none'
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
    const durationBucketKey = searchParams.get("durationBucket");

    if (!VALID_BUCKETS.has(bucket)) {
      return errorResponse(`Invalid bucket: ${bucket}`, 400);
    }

    // Duration filter, set by clicking a bar on the campaign's call-duration
    // histogram. Resolved against the SAME configured buckets the chart was
    // drawn from, so an unrecognised key is a 400 rather than an empty table
    // that looks like "no calls lasted that long".
    let durationBounds: { lo: number; hi: number | null } | null = null;
    if (durationBucketKey) {
      const { buckets } = await resolveDurationBucketConfig();
      const hit = buckets.find((b) => b.key === durationBucketKey);
      if (!hit) {
        return errorResponse(`Invalid durationBucket: ${durationBucketKey}`, 400);
      }
      durationBounds = { lo: hit.loSeconds, hi: hit.hiSeconds };
    }

    // bucket=all returns three buckets in one round-trip for the banner. A
    // duration filter always wants the paginated list instead, whatever status
    // tab happens to be showing.
    if (bucket === "all" && !durationBounds) {
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

    const conditions = [eq(dialerCampaignLeads.campaign_id, campaignId)];

    // A duration bucket REPLACES the status filter rather than narrowing it.
    // The histogram counts every call that reached a dealer, and a call can
    // carry a real conversation while its row still reads 'failed' (see the
    // evidence-order note in failureReason.ts). Intersecting the two would
    // return FEWER rows than the bar the user just clicked promised — the exact
    // "confident wrong number" this feature exists to prevent. Duration bounds
    // alone are the precise population: a derived duration exists ONLY for a
    // call something proves connected, so `>= lo` already excludes every call
    // that never did. That was not true until the wall-clock fallback was gated
    // on the transcript — before then a trigger_failed lead carried the seconds
    // the dialer spent failing as its "duration" and matched these bounds.
    if (bucket !== "all" && !durationBounds) {
      conditions.push(inArray(dialerCampaignLeads.status, [bucket]));
    }

    if (durationBounds) {
      // Half-open [lo, hi), the same rule the histogram bins by — the shared
      // expression is what stops a bar reading 47 while the table it filters
      // returns 44. `hi` is omitted rather than compared to NULL for the open
      // top bucket, so no untyped null reaches the driver.
      const duration = correlatedDurationSeconds(
        dialerCampaignLeads.started_at,
        dialerCampaignLeads.completed_at,
        dialerCampaignLeads.bolna_call_id,
      );
      conditions.push(sql`${duration} >= ${durationBounds.lo}`);
      if (durationBounds.hi !== null) {
        conditions.push(sql`${duration} < ${durationBounds.hi}`);
      }
    }

    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

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
