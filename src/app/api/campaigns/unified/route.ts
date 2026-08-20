// GET /api/campaigns/unified?page=N&limit=N&kind=ai_dialer|neodove
//
// One list covering both campaign engines, for the Campaigns tab on /leads.
//
// The tab has always shown AI-dialer campaigns (dialer_campaigns, driven by
// Bolna/ElevenLabs). NeoDove campaigns are the same idea run by human agents,
// so they belong in the same list rather than a second screen the team has to
// remember to check.
//
// They stay in SEPARATE TABLES and are UNIONed here. dialer_campaigns is
// coupled to advanceCampaign() and the /api/cron/ai-dialer + dialer-watchdog
// sweeps, which claim rows WHERE status='running' and place real calls — a
// NeoDove row living there would eventually be robot-dialled against an
// audience meant for people. The union costs one query branch; merging the
// tables would cost a class of bug nobody would catch until dealers complained.
//
// Output shape is a superset of /api/ai-dialer/campaigns (same keys, same
// casing, same `{data, page}` envelope) plus `kind`, so CampaignsTable renders
// one row type and the existing columns keep working untouched.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

// E-224 is additive and unapplied on some DBs (prod at time of writing). A
// missing table is a PARSE-time failure, not a row-count of zero: naming
// neodove_campaigns in a CTE fails the whole statement even when its WHERE is
// false, which would take the AI-dialer half of the tab down with it. So probe
// first and omit the CTE entirely rather than let the union throw.
//
// Cached only once TRUE — a table cannot un-create itself, but a table that is
// absent today may be created by applying E-224 without restarting the server,
// and caching FALSE would keep the tab NeoDove-blind until a redeploy.
let neodoveTablesPresent = false;

async function hasNeodoveTables(): Promise<boolean> {
    if (neodoveTablesPresent) return true;
    const probe = await db.execute<{ present: boolean }>(sql`
        SELECT to_regclass('public.neodove_campaigns') IS NOT NULL
           AND to_regclass('public.neodove_lead_links') IS NOT NULL AS present
    `);
    neodoveTablesPresent = Boolean(
        (probe as unknown as { present: boolean }[])[0]?.present,
    );
    return neodoveTablesPresent;
}

export type UnifiedCampaignRow = {
    id: string;
    kind: "ai_dialer" | "neodove";
    name: string;
    status: string;
    provider: string;
    category: string | null;
    regionFilter: unknown;
    totalLeads: number;
    callsMade: number;
    completedLeads: number;
    failedLeads: number;
    startedAt: string | null;
    completedAt: string | null;
    triggeredBy: string | null;
    triggeredByName: string | null;
    totalTalkTimeSeconds: number | null;
    // E-228/E-254 — NULL on the NeoDove half: those are human-agent campaigns
    // and have no dialer calling window.
    scheduleMode: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    windowDays: unknown;
    resumeAfter: string | null;
};

export const GET = withErrorHandler(async (req: Request) => {
    await requireAuth();

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page") || 1));
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 10)));
    const offset = (page - 1) * limit;

    const kind = searchParams.get("kind");
    const wantAi = kind !== "neodove";
    const wantNeodove = kind !== "ai_dialer" && (await hasNeodoveTables());

    // NeoDove counter mapping, stated once here so the UI never has to guess:
    //   totalLeads     ← links created for the campaign (the intended audience)
    //   callsMade      ← dispositions received back from NeoDove
    //   completedLeads ← leads successfully pushed
    //   failedLeads    ← leads that failed to push
    // totalTalkTimeSeconds is NULL for NeoDove: call durations only arrive if
    // their webhook carries one, and it belongs on the detail page rather than
    // being faked as a zero here.
    const rows = await db.execute<UnifiedCampaignRow>(sql`
        WITH ai AS (
            SELECT c.id::text AS id,
                   'ai_dialer'::text AS kind,
                   c.name,
                   c.status,
                   c.provider,
                   c.category,
                   c.region_filter AS "regionFilter",
                   c.total_leads AS "totalLeads",
                   c.calls_made AS "callsMade",
                   c.completed_leads AS "completedLeads",
                   c.failed_leads AS "failedLeads",
                   c.started_at AS "startedAt",
                   c.completed_at AS "completedAt",
                   c.triggered_by::text AS "triggeredBy",
                   u.name AS "triggeredByName",
                   (
                     SELECT COALESCE(SUM(
                       CASE
                         WHEN acl.call_duration IS NOT NULL AND acl.call_duration > 0
                           THEN acl.call_duration
                         WHEN dcl.started_at IS NOT NULL AND dcl.completed_at IS NOT NULL
                              AND EXTRACT(epoch FROM (dcl.completed_at - dcl.started_at)) > 0
                              AND EXTRACT(epoch FROM (dcl.completed_at - dcl.started_at)) < 7200
                           THEN EXTRACT(epoch FROM (dcl.completed_at - dcl.started_at))::int
                         ELSE 0
                       END), 0)::int
                     FROM dialer_campaign_leads dcl
                     LEFT JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
                     WHERE dcl.campaign_id = c.id
                   ) AS "totalTalkTimeSeconds",
                   c.schedule_mode AS "scheduleMode",
                   c.window_start AS "windowStart",
                   c.window_end AS "windowEnd",
                   c.window_days AS "windowDays",
                   c.resume_after AS "resumeAfter",
                   COALESCE(c.started_at, c.created_at) AS sort_key
              FROM dialer_campaigns c
              LEFT JOIN users u ON u.id = c.triggered_by
             -- Raw literal, not a bind param: WHERE with a bare placeholder
             -- leaves Postgres no way to infer the parameter's type. Both
             -- values are derived here from a fixed string compare, never
             -- from user input. (No backticks in this comment -- the whole
             -- statement is a JS template literal and one would end it.)
             WHERE ${sql.raw(wantAi ? "true" : "false")}
        )
        ${wantNeodove ? sql`
        , nd AS (
            SELECT c.id::text AS id,
                   'neodove'::text AS kind,
                   c.name,
                   c.status,
                   'neodove'::text AS provider,
                   c.neodove_campaign_name AS category,
                   c.audience_filter AS "regionFilter",
                   COALESCE(l.link_count, 0)::int AS "totalLeads",
                   c.dispositions_received AS "callsMade",
                   c.total_pushed AS "completedLeads",
                   c.push_failed AS "failedLeads",
                   c.started_at AS "startedAt",
                   c.completed_at AS "completedAt",
                   c.created_by::text AS "triggeredBy",
                   u.name AS "triggeredByName",
                   NULL::int AS "totalTalkTimeSeconds",
                   -- Explicitly cast rather than bare NULL. Postgres can often
                   -- infer an untyped NULL's type from the other UNION branch,
                   -- but it is not obliged to, and when it cannot the failure
                   -- is the WHOLE statement -- which would take the AI-dialer
                   -- half of the tab down with it, not just the NeoDove half.
                   NULL::varchar AS "scheduleMode",
                   NULL::varchar AS "windowStart",
                   NULL::varchar AS "windowEnd",
                   NULL::jsonb AS "windowDays",
                   NULL::timestamptz AS "resumeAfter",
                   COALESCE(c.started_at, c.created_at) AS sort_key
              FROM neodove_campaigns c
              LEFT JOIN users u ON u.id = c.created_by
              LEFT JOIN (
                    SELECT neodove_campaign_id, COUNT(*) AS link_count
                      FROM neodove_lead_links GROUP BY neodove_campaign_id
                   ) l ON l.neodove_campaign_id = c.id
        )` : sql``}
        SELECT id, kind, name, status, provider, category, "regionFilter",
               "totalLeads", "callsMade", "completedLeads", "failedLeads",
               "startedAt", "completedAt", "triggeredBy", "triggeredByName",
               "totalTalkTimeSeconds", "scheduleMode", "windowStart",
               "windowEnd", "windowDays", "resumeAfter"
          FROM (
                SELECT * FROM ai
                ${wantNeodove ? sql`UNION ALL SELECT * FROM nd` : sql``}
               ) merged
         ORDER BY sort_key DESC NULLS LAST
         LIMIT ${limit} OFFSET ${offset}
    `);

    // Same envelope as /api/ai-dialer/campaigns so CampaignsTable's existing
    // `data?.data` access keeps working.
    return successResponse({ data: rows, page });
});
