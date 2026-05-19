// SQL builders for /api/campaigns/cost-analytics. Mirrors the pattern of
// src/lib/sales-insight/query.ts — one builder per panel of the dashboard,
// all sharing the same filter shape so the CSV export and the JSON API can
// stay in lockstep.
//
// Join: dialer_campaigns ⋈ dialer_campaign_leads ⋈ ai_call_logs, with
//   dialer_campaign_leads.bolna_call_id = ai_call_logs.call_id
// (the column name is legacy; it now stores both Bolna execution IDs and
// ElevenLabs conversation IDs — see webhook handlers).
//
// Date range filters on ai_call_logs.ended_at because cost is per-call,
// not per-campaign — a long-running campaign should show spend on the day
// each call actually happened, not the day the campaign started.

import { sql, type SQL } from "drizzle-orm";

export type CostAnalyticsFilters = {
  from_date: string | null;
  to_date: string | null;
  provider: "bolna" | "elevenlabs" | null;
  campaign_id: string | null;
  page: number;
  limit: number;
};

// Build the WHERE clause shared by every panel. Always references aliases
// `acl` (ai_call_logs) and `dcl` (dialer_campaign_leads).
function whereClause(f: CostAnalyticsFilters): SQL {
  const parts: SQL[] = [
    sql`acl.call_id IS NOT NULL`,
    sql`dcl.bolna_call_id IS NOT NULL`,
  ];
  if (f.from_date) {
    parts.push(sql`acl.ended_at >= ${f.from_date}::date`);
  }
  if (f.to_date) {
    parts.push(sql`acl.ended_at < (${f.to_date}::date + interval '1 day')`);
  }
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
    FROM dialer_campaign_leads dcl
    INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
    WHERE ${whereClause(f)}
  `;
}

export function buildTrendSql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT
      DATE_TRUNC('day', acl.ended_at AT TIME ZONE 'Asia/Kolkata')::date as date,
      COALESCE(SUM(acl.total_cost_cents), 0)::bigint as cost_cents,
      COUNT(*)::int as calls
    FROM dialer_campaign_leads dcl
    INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
    WHERE ${whereClause(f)}
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
    FROM dialer_campaign_leads dcl
    INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
    WHERE ${whereClause(f)}
  `;
}

export function buildProviderSplitSql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT
      acl.provider as provider,
      COALESCE(SUM(acl.total_cost_cents), 0)::bigint as cost_cents,
      COUNT(*)::int as calls,
      COALESCE(SUM(acl.call_duration), 0)::bigint as duration_secs
    FROM dialer_campaign_leads dcl
    INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
    WHERE ${whereClause(f)}
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
    WHERE ${whereClause(f)}
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
    WHERE ${whereClause(f)}
    ORDER BY acl.ended_at DESC NULLS LAST
    LIMIT ${f.limit} OFFSET ${offset}
  `;
}

export function buildCallDetailCountSql(f: CostAnalyticsFilters): SQL {
  return sql`
    SELECT COUNT(*)::int as count
    FROM dialer_campaign_leads dcl
    INNER JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
    WHERE ${whereClause(f)}
  `;
}
