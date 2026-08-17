// GET /api/dealer-leads/[id]/ai-summary — what the AI knows about one lead.
//
// ONE lead-scoped route, deliberately serving two callers:
//   · the "already contacted by AI" notice shown when the hard block refuses a
//     lead (needs the summary, the band and a transcript link)
//   · the AI signals panel on the lead detail screens
//
// WHY NOT REUSE the campaign transcript route. The obvious candidate,
// /api/ai-dialer/campaigns/[id]/leads/[leadId]/transcript, is 445 lines, runs
// five queries (campaign-lead join, latest log, cross-campaign attempt timeline,
// per-attempt recordings, intent feedback) and — decisively — 404s when the lead
// is not in the campaign. That is exactly the blocked-lead case. Making its
// campaignId optional would fork its first query and every downstream
// isCurrent computation. This is two queries and no campaign concept.
//
// WHY NOT /api/leads/[id]/ai-summary. /api/leads/* is the customer/loan
// `leads` table, a different entity — putting dealer-lead work there is the bug
// documented at length in ../route.ts, where every edit 404'd silently.

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";

type LatestCallRow = {
  call_id: string | null;
  provider: string | null;
  status: string | null;
  summary: string | null;
  intent_reason: string | null;
  band: string | null;
  call_status: string | null;
  intent_score: number | null;
  info_signals_count: number | null;
  scoring_version: string | null;
  recording_url: string | null;
  call_duration: number | null;
  called_at: string | Date | null;
  has_transcript: boolean | null;
  transcript: string | null;
  signals: unknown;
  score_breakdown: unknown;
  attempt_count: number | null;
  connected_attempt_count: number | null;
  campaign_id: string | null;
  campaign_name: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

function iso(v: string | Date | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

export const GET = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole([...LEADS_PAGE_ROLES]);

    const { id } = await ctx.params;
    const url = new URL(req.url);
    // The transcript is a large text column and neither the notice nor the
    // panel renders it inline — they link to the drawer. Opt in explicitly so
    // the common payload stays small.
    const includeTranscript = url.searchParams.get("include") === "transcript";

    const result = await db.execute(sql`
      SELECT acl.call_id,
             acl.provider,
             acl.status,
             acl.summary,
             acl.intent_reason,
             acl.band,
             acl.call_status,
             acl.intent_score,
             acl.info_signals_count,
             acl.scoring_version,
             acl.recording_url,
             acl.call_duration,
             COALESCE(acl.ended_at, acl.created_at) AS called_at,
             (acl.transcript IS NOT NULL)           AS has_transcript,
             ${includeTranscript ? sql`acl.transcript` : sql`NULL::text`} AS transcript,
             acl.signals,
             acl.score_breakdown,
             (SELECT COUNT(*)::int FROM ai_call_logs x WHERE x.lead_id = ${id})
                                                    AS attempt_count,
             (SELECT COUNT(*)::int FROM ai_call_logs x
               WHERE x.lead_id = ${id} AND x.transcript IS NOT NULL)
                                                    AS connected_attempt_count,
             dcl.campaign_id,
             dc.name AS campaign_name
        FROM ai_call_logs acl
        LEFT JOIN LATERAL (
              SELECT campaign_id FROM dialer_campaign_leads
               WHERE lead_id = ${id}
               ORDER BY created_at DESC LIMIT 1
        ) dcl ON true
        LEFT JOIN dialer_campaigns dc ON dc.id = dcl.campaign_id
       WHERE acl.lead_id = ${id}
       ORDER BY COALESCE(acl.ended_at, acl.created_at) DESC
       LIMIT 1
    `);

    const row = rowsOf<LatestCallRow>(result)[0];

    if (!row) {
      return successResponse({
        hasAiCall: false,
        attemptCount: 0,
        connectedAttemptCount: 0,
        connected: false,
        latest: null,
      });
    }

    return successResponse({
      hasAiCall: true,
      attemptCount: row.attempt_count ?? 0,
      connectedAttemptCount: row.connected_attempt_count ?? 0,
      // THE shared definition of "connected", computed once in SQL so the notice
      // and the hard block can never disagree about it.
      connected: Boolean(row.has_transcript),
      latest: {
        callId: row.call_id,
        provider: row.provider,
        status: row.status,
        calledAt: iso(row.called_at),
        callDuration: row.call_duration,
        // Same self-healing proxy fallback the transcript route uses, so a call
        // whose recording landed late is still playable.
        recordingUrl:
          row.recording_url ??
          (row.call_id ? `/api/ai-dialer/recording/${row.call_id}` : null),
        band: row.band,
        callStatus: row.call_status,
        intentScore: row.intent_score,
        intentReason: row.intent_reason,
        infoSignalsCount: row.info_signals_count,
        scoringVersion: row.scoring_version,
        summary: row.summary,
        signals: row.signals ?? null,
        scoreBreakdown: row.score_breakdown ?? null,
        transcript: row.transcript ?? null,
        // Lets the caller deep-link the existing campaign transcript drawer.
        // Null for a manual one-off call, which that drawer cannot render.
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
      },
    });
  },
);
