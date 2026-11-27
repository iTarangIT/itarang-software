/**
 * LinkedIn campaign analytics by category (E-398): Approached → Accepted →
 * Replied → Meeting scheduled, per campaign and rolled up per category.
 *
 * One SQL statement per call (counts never come from two queries that can
 * disagree). A row is "approached" when we sent an invite or a direct message;
 * the date filter applies to that first-touch time, in IST calendar days.
 * Without E-398 every campaign is "Uncategorised" and meetings are 0.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";

import { UNCATEGORISED } from "../categories";
import { extrasReady } from "./extras";
import type { CampaignFunnel } from "./funnel";

export type { CampaignFunnel, CategoryFunnel, FunnelCounts } from "./funnel";
export { pctOf, rollUp } from "./funnel";
import { rollUp } from "./funnel";

export type AnalyticsFilters = {
  from?: string | null; // YYYY-MM-DD, IST, inclusive
  to?: string | null; // YYYY-MM-DD, IST, inclusive
  category?: string | null;
  accountId?: string | null;
  campaignId?: string | null;
  status?: string | null; // campaign status
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** WHERE fragments for the campaign-prospect rows `cp` of campaigns `c` (cat = category expr). */
export function rowFilters(f: AnalyticsFilters, cat: SQL): SQL[] {
  const where: SQL[] = [sql`TRUE`];
  const touched = sql`COALESCE(cp.invite_sent_at, cp.message_sent_at)`;
  if (f.from && DATE_RE.test(f.from)) where.push(sql`${touched} >= (${f.from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (f.to && DATE_RE.test(f.to)) where.push(sql`${touched} < ((${f.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (f.category) where.push(sql`${cat} = ${f.category}`);
  if (f.accountId) where.push(sql`c.account_id = ${f.accountId}::uuid`);
  if (f.campaignId) where.push(sql`c.id = ${f.campaignId}::uuid`);
  if (f.status) where.push(sql`c.status = ${f.status}`);
  return where;
}

/** Category + meeting expressions, depending on whether E-398 is applied. */
export async function extrasSql(): Promise<{ cat: SQL; meeting: SQL; join: SQL }> {
  if (await extrasReady()) {
    return {
      cat: sql`COALESCE(cc.category, ${UNCATEGORISED})`,
      meeting: sql`EXISTS (SELECT 1 FROM li_meetings m WHERE m.campaign_prospect_id = cp.id)`,
      join: sql`LEFT JOIN li_campaign_categories cc ON cc.campaign_id = c.id`,
    };
  }
  return { cat: sql`${UNCATEGORISED}::text`, meeting: sql`FALSE`, join: sql`` };
}

const num = (v: unknown) => Number(v ?? 0);

export async function campaignFunnels(f: AnalyticsFilters): Promise<CampaignFunnel[]> {
  const x = await extrasSql();
  const dated = Boolean((f.from && DATE_RE.test(f.from)) || (f.to && DATE_RE.test(f.to)));
  const rows = await db.execute(sql`
    SELECT c.id AS campaign_id, c.name, c.status, c.account_id, c.created_at, ${x.cat} AS category,
      count(cp.id)::int AS selected,
      count(cp.id) FILTER (WHERE cp.invite_sent_at IS NOT NULL OR cp.message_sent_at IS NOT NULL)::int AS approached,
      count(cp.id) FILTER (WHERE cp.invite_sent_at IS NOT NULL)::int AS invited,
      count(cp.id) FILTER (WHERE cp.invite_sent_at IS NOT NULL AND cp.accepted_at IS NOT NULL)::int AS accepted,
      count(cp.id) FILTER (WHERE cp.replied_at IS NOT NULL)::int AS replied,
      count(cp.id) FILTER (WHERE ${x.meeting})::int AS meetings,
      count(cp.id) FILTER (WHERE EXISTS (
        SELECT 1 FROM li_conversations cv
        WHERE cv.campaign_id = c.id AND cv.prospect_id = cp.prospect_id AND cv.sentiment = 'positive'
      ))::int AS positive
    FROM li_campaigns c
    ${x.join}
    ${dated ? sql`JOIN` : sql`LEFT JOIN`} li_campaign_prospects cp ON cp.campaign_id = c.id
    WHERE ${sql.join(rowFilters(f, x.cat), sql` AND `)}
    -- By position: the category expression carries a bind parameter, and two
    -- copies of it ($n vs $m) would not count as the same GROUP BY expression.
    GROUP BY 1, 2, 3, 4, 5, 6
    ORDER BY c.created_at DESC`);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    campaign_id: String(r.campaign_id),
    name: String(r.name),
    status: String(r.status),
    category: String(r.category),
    account_id: String(r.account_id),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    selected: num(r.selected),
    approached: num(r.approached),
    invited: num(r.invited),
    accepted: num(r.accepted),
    replied: num(r.replied),
    meetings: num(r.meetings),
    positive: num(r.positive),
  }));
}

export async function analytics(f: AnalyticsFilters) {
  const campaigns = await campaignFunnels(f);
  return { ...rollUp(campaigns), campaigns, extras_ready: await extrasReady() };
}
