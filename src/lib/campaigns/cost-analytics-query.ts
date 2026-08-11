// SQL builders for /api/campaigns/cost-analytics.
//
// **Scope evolution (May 2026):** The dashboard previously inner-joined
// `dialer_campaign_leads` so only campaign-driven calls counted. That hid
// real spend on calls placed from the IS-rep workspace, ASM workspace, test
// runs, and any campaign call whose webhook dropped without a DCL row to
// backfill from. Independent ground-truth pulls from the ElevenLabs LIST
// API showed the dashboard total was ~5× too low because of this filter.
//
// Now: summary / trend / component / provider panels read **all rows from
// `ai_call_logs`** (filtered by date + provider). The top-campaigns panel
// keeps its INNER JOIN to `dialer_campaign_leads` because that panel is
// definitionally about campaigns; non-campaign calls have no campaign to
// attribute to.
//
// Date range filters on `ai_call_logs.ended_at` because cost is per-call,
// not per-campaign.

import { sql, type SQL } from "drizzle-orm";

export type CostAnalyticsFilters = {
  from_date: string | null;
  to_date: string | null;
  provider: "bolna" | "elevenlabs" | null;
  campaign_id: string | null;
  page: number;
  limit: number;
};

/**
 * The window bounds, as IST calendar days.
 *
 * `ended_at` is timestamptz and the callers' dates are IST calendar days. A
 * bare `${date}::date` comparison casts the date to timestamptz using the
 * SESSION timezone, and nothing in src/lib/db sets one — so on a UTC server the
 * window was a UTC day while every GROUP BY on this same column buckets by
 * `AT TIME ZONE 'Asia/Kolkata'`. That is a 5h30m skew at each edge: calls
 * between 00:00 and 05:30 IST on a boundary day fell on the wrong side of the
 * filter while being bucketed on the right side of the chart.
 *
 * Casting to a naive `timestamp` first and then applying `AT TIME ZONE` pins
 * the boundary to midnight IST regardless of where the server thinks it is.
 * Same construction as src/lib/operations/spend.ts, which has always done this
 * correctly against the same column.
 *
 * `to_date` stays INCLUSIVE, expressed as a half-open `< to + 1 day`.
 */
function istDayBounds(from: string | null, to: string | null): SQL[] {
  const parts: SQL[] = [];
  if (from) {
    parts.push(
      sql`acl.ended_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
  if (to) {
    parts.push(
      sql`acl.ended_at < ((${to}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
  return parts;
}

// WHERE clause for panels that read ai_call_logs directly (no DCL join).
// Always references the alias `acl`.
function whereClauseAcl(f: CostAnalyticsFilters): SQL {
  const parts: SQL[] = [sql`acl.call_id IS NOT NULL`];
  parts.push(...istDayBounds(f.from_date, f.to_date));
  if (f.provider) {
    parts.push(sql`acl.provider = ${f.provider}`);
  }
  // campaign_id is *only* meaningful when joined to dialer_campaign_leads.
  // The campaign-scoped panels build their own WHERE that includes it.
  return sql.join(parts, sql` AND `);
}

// WHERE clause for panels that DO join dialer_campaign_leads (top campaigns,
// call-detail drawer). Includes the campaign_id filter.
function whereClauseDcl(f: CostAnalyticsFilters): SQL {
  const parts: SQL[] = [
    sql`acl.call_id IS NOT NULL`,
    sql`dcl.bolna_call_id IS NOT NULL`,
  ];
  parts.push(...istDayBounds(f.from_date, f.to_date));
  if (f.provider) {
    parts.push(sql`acl.provider = ${f.provider}`);
  }
  if (f.campaign_id) {
    parts.push(sql`dcl.campaign_id = ${f.campaign_id}`);
  }
  return sql.join(parts, sql` AND `);
}

export function buildSummarySql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT
      COALESCE(SUM(acl.total_cost_cents), 0)::bigint as total_cost_cents,
      COUNT(*)::int as total_calls,
      COALESCE(SUM(acl.call_duration), 0)::bigint as total_duration_secs,
      COUNT(acl.total_cost_cents)::int as calls_with_cost
    FROM ai_call_logs acl
    WHERE ${whereClauseAcl(f)}
  `;
}

export function buildTrendSql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT
      DATE_TRUNC('day', acl.ended_at AT TIME ZONE 'Asia/Kolkata')::date as date,
      COALESCE(SUM(acl.total_cost_cents), 0)::bigint as cost_cents,
      COUNT(*)::int as calls
    FROM ai_call_logs acl
    WHERE ${whereClauseAcl(f)}
    GROUP BY DATE_TRUNC('day', acl.ended_at AT TIME ZONE 'Asia/Kolkata')
    ORDER BY date ASC
  `;
}

export function buildComponentBreakdownSql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT
      COALESCE(SUM(acl.llm_cost_cents), 0)::bigint as llm,
      COALESCE(SUM(acl.tts_cost_cents), 0)::bigint as tts,
      COALESCE(SUM(acl.stt_cost_cents), 0)::bigint as stt,
      COALESCE(SUM(acl.telephony_cost_cents), 0)::bigint as telephony,
      COALESCE(SUM(acl.platform_cost_cents), 0)::bigint as platform
    FROM ai_call_logs acl
    WHERE ${whereClauseAcl(f)}
  `;
}

export function buildProviderSplitSql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT
      acl.provider as provider,
      COALESCE(SUM(acl.total_cost_cents), 0)::bigint as cost_cents,
      COUNT(*)::int as calls,
      COALESCE(SUM(acl.call_duration), 0)::bigint as duration_secs
    FROM ai_call_logs acl
    WHERE ${whereClauseAcl(f)}
    GROUP BY acl.provider
    ORDER BY cost_cents DESC
  `;
}

export function buildTopCampaignsSql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT
      dc.id as id,
      dc.name as name,
      dc.provider as provider,
      dc.calls_made as calls_made,
      dc.total_leads as total_leads,
      dc.started_at as started_at,
      COALESCE(SUM(acl.total_cost_cents), 0)::bigint as total_cost_cents,
      COUNT(acl.call_id)::int as cost_calls,
      COALESCE(SUM(acl.call_duration), 0)::bigint as total_duration_secs
    FROM dialer_campaigns dc
    INNER JOIN dialer_campaign_leads dcl ON dcl.campaign_id = dc.id
    INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
    WHERE ${whereClauseDcl(f)}
    GROUP BY dc.id, dc.name, dc.provider, dc.calls_made, dc.total_leads, dc.started_at
    ORDER BY total_cost_cents DESC
    LIMIT 10
  `;
}

// Per-call detail — only invoked when campaign_id is set (the drawer).
export function buildCallDetailSql(f: CostAnalyticsFilters): SQL {
  const offset = Math.max(0, (f.page - 1) * f.limit);
  return sql`
    SELECT
      acl.call_id as call_id,
      acl.lead_id as lead_id,
      acl.provider as provider,
      acl.status as status,
      acl.started_at as started_at,
      acl.ended_at as ended_at,
      acl.call_duration as duration_secs,
      acl.total_cost_cents as total_cost_cents,
      acl.llm_cost_cents as llm_cost_cents,
      acl.tts_cost_cents as tts_cost_cents,
      acl.stt_cost_cents as stt_cost_cents,
      acl.telephony_cost_cents as telephony_cost_cents,
      acl.platform_cost_cents as platform_cost_cents,
      acl.cost_fetched_at as cost_fetched_at,
      dl.shop_name as shop_name,
      dl.phone as phone
    FROM dialer_campaign_leads dcl
    INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
    LEFT JOIN dealer_leads dl ON dl.id = acl.lead_id
    WHERE ${whereClauseDcl(f)}
    ORDER BY acl.ended_at DESC NULLS LAST
    LIMIT ${f.limit} OFFSET ${offset}
  `;
}

export function buildCallDetailCountSql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT COUNT(*)::int as count
    FROM dialer_campaign_leads dcl
    INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
    WHERE ${whereClauseDcl(f)}
  `;
}
