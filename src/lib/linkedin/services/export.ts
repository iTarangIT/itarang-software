/**
 * LinkedIn exports (E-398): campaign rows, prospects, and the category
 * analytics table, as .xlsx (or .csv). Each export takes the same filters as
 * the screen it is downloaded from. Raw provider JSON and provider ids are
 * never exported.
 */
import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { analytics, extrasSql, rowFilters, type AnalyticsFilters } from "./analytics";
import { pctOf } from "./funnel";
import { listProspects, type ProspectFilters } from "./prospects";

import type { Column, Table } from "../lib/csv";

export type { Column, Table } from "../lib/csv";
export { toCsv } from "../lib/csv";

const EXPORT_CAP = 10_000;

const ist = (v: unknown): string => {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
};

// ── Campaign rows ─────────────────────────────────────────────────────────

export async function campaignRowsTable(f: AnalyticsFilters & { state?: string | null }): Promise<Table> {
  const x = await extrasSql();
  const where = rowFilters(f, x.cat);
  if (f.state) where.push(sql`cp.state = ${f.state}`);
  const rows = (await db.execute(sql`
    SELECT c.name AS campaign, ${x.cat} AS category, c.status AS campaign_status,
      p.full_name, p.headline, p.company, p.city, p.public_url, p.lead_id,
      cp.state, cp.invite_sent_at, cp.accepted_at, cp.message_sent_at, cp.replied_at,
      ${x.meeting} AS meeting,
      (SELECT cv.sentiment FROM li_conversations cv
        WHERE cv.campaign_id = c.id AND cv.prospect_id = cp.prospect_id
        ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1) AS sentiment,
      cp.stopped_reason, cp.last_error
    FROM li_campaign_prospects cp
    JOIN li_campaigns c ON c.id = cp.campaign_id
    JOIN li_prospects p ON p.id = cp.prospect_id
    ${x.join}
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY c.created_at DESC, p.full_name
    LIMIT ${EXPORT_CAP}`)) as unknown as Record<string, unknown>[];
  return {
    name: "Campaign prospects",
    columns: [
      { key: "campaign", header: "Campaign", width: 28 },
      { key: "category", header: "Category", width: 14 },
      { key: "full_name", header: "Name", width: 24 },
      { key: "headline", header: "Headline", width: 40 },
      { key: "company", header: "Company", width: 24 },
      { key: "city", header: "City", width: 16 },
      { key: "public_url", header: "LinkedIn URL", width: 40 },
      { key: "state", header: "State", width: 14 },
      { key: "approached", header: "Approached", width: 11 },
      { key: "invite_sent_at", header: "Invite sent", width: 20 },
      { key: "accepted_at", header: "Accepted", width: 20 },
      { key: "message_sent_at", header: "Message sent", width: 20 },
      { key: "replied_at", header: "Replied", width: 20 },
      { key: "meeting", header: "Meeting scheduled", width: 12 },
      { key: "sentiment", header: "Reply sentiment", width: 12 },
      { key: "lead_id", header: "CRM lead", width: 14 },
      { key: "campaign_status", header: "Campaign status", width: 12 },
      { key: "note", header: "Stopped / error", width: 30 },
    ],
    rows: rows.map((r) => ({
      ...r,
      approached: r.invite_sent_at || r.message_sent_at ? "Yes" : "No",
      invite_sent_at: ist(r.invite_sent_at),
      accepted_at: ist(r.accepted_at),
      message_sent_at: ist(r.message_sent_at),
      replied_at: ist(r.replied_at),
      meeting: r.meeting ? "Yes" : "No",
      note: r.stopped_reason ?? r.last_error ?? "",
    })),
  };
}

// ── Prospects ─────────────────────────────────────────────────────────────

export async function prospectsTable(f: ProspectFilters): Promise<Table> {
  const { rows } = await listProspects({ ...f, page: 1, pageSize: EXPORT_CAP, forExport: true });
  return {
    name: "Prospects",
    columns: [
      { key: "full_name", header: "Name", width: 24 },
      { key: "headline", header: "Headline", width: 40 },
      { key: "company", header: "Company", width: 24 },
      { key: "city", header: "City", width: 16 },
      { key: "public_url", header: "LinkedIn URL", width: 40 },
      { key: "contacted", header: "Campaign states", width: 24 },
      { key: "do_not_contact", header: "Do not contact", width: 12 },
      { key: "lead_id", header: "CRM lead", width: 14 },
      { key: "created_at", header: "Found on", width: 20 },
    ],
    rows: rows.map((r) => ({
      full_name: r.full_name,
      headline: r.headline,
      company: r.company,
      city: r.city,
      public_url: r.public_url,
      contacted: r.campaigns.map((c) => c.state).join(", "),
      do_not_contact: r.do_not_contact ? "Yes" : "No",
      lead_id: r.lead_id,
      created_at: ist(r.created_at),
    })),
  };
}

// ── Analytics ─────────────────────────────────────────────────────────────

export async function analyticsTables(f: AnalyticsFilters): Promise<Table[]> {
  const a = await analytics(f);
  const funnelCols: Column[] = [
    { key: "approached", header: "Approached", width: 11 },
    { key: "accepted", header: "Invite accepted", width: 14 },
    { key: "accepted_pct", header: "Accepted % of invites", width: 12 },
    { key: "replied", header: "Replied", width: 10 },
    { key: "replied_pct", header: "Replied %", width: 10 },
    { key: "meetings", header: "Meeting scheduled", width: 12 },
    { key: "meetings_pct", header: "Meeting %", width: 10 },
  ];
  const withPct = <T extends { approached: number; invited: number; accepted: number; replied: number; meetings: number }>(r: T) => ({
    ...r,
    accepted_pct: r.invited > 0 ? Math.round((r.accepted / r.invited) * 1000) / 10 : "",
    replied_pct: pctOf(r.replied, r.approached) ?? "",
    meetings_pct: pctOf(r.meetings, r.approached) ?? "",
  });
  return [
    {
      name: "By category",
      columns: [{ key: "category", header: "Category", width: 16 }, { key: "campaigns", header: "Campaigns", width: 10 }, ...funnelCols],
      rows: [...a.categories, a.total].map(withPct),
    },
    {
      name: "By campaign",
      columns: [
        { key: "name", header: "Campaign", width: 28 },
        { key: "category", header: "Category", width: 14 },
        { key: "status", header: "Status", width: 10 },
        ...funnelCols,
      ],
      rows: a.campaigns.map(withPct),
    },
  ];
}

// ── Writers ───────────────────────────────────────────────────────────────

export async function toXlsx(tables: Table[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "iTarang CRM";
  for (const t of tables) {
    const ws = wb.addWorksheet(t.name.slice(0, 31));
    ws.columns = t.columns.map((c) => ({ key: c.key, header: c.header, width: c.width ?? 16 }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const r of t.rows) {
      const row: Record<string, unknown> = {};
      for (const c of t.columns) row[c.key] = r[c.key] ?? "";
      ws.addRow(row);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
