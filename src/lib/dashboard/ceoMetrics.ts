/**
 * The CEO dashboard's headline aggregates, as one reusable module.
 *
 * WHY THIS EXISTS. /operations/business is a read-only mirror of these numbers
 * so the tech team can see whether a deploy broke a pipeline. A mirror that
 * computes its own version of "revenue" is not a mirror — it is a second
 * opinion, and when the two disagree nobody can tell which is wrong.
 *
 * The definitions below are lifted from src/app/api/dashboard/[role]/route.ts
 * (the `role === "ceo"` branch), which remains the shipped source of the CEO
 * tiles. Each carries the filter subtleties that route learned the hard way —
 * they are NOT interchangeable and the differences are deliberate:
 *
 *   · revenue excludes ONLY 'void'. Drafts COUNT as revenue, per an explicit
 *     CEO decision.
 *   · outstanding excludes 'paid', 'void' AND 'draft'. A draft is unsent and
 *     is not a receivable; Zoho's own "Total Receivables" excludes them too.
 *     Omitting the draft exclusion once inflated this from ₹7.89L to ₹1.16Cr.
 *   · conversions are `current_status = 'qualified'` exactly — case-sensitive,
 *     and NOT including 'ai_qualified'. dealer_leads contains both 'new' and
 *     'New', so loosening this would change the number.
 *
 * FOLLOW-UP: src/app/api/dashboard/[role]/route.ts still has its own inline
 * copies of these queries. Switching it to import from here is the change that
 * makes drift structurally impossible; it was left out of this phase to keep a
 * live CEO route out of the blast radius. Until then, a change there must be
 * made here too.
 */

import { and, gte, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerLeads, dealers, zohoInvoices } from "@/lib/db/schema";

export interface MonthWindow {
  /** Inclusive start, YYYY-MM-DD. */
  startStr: string;
  /** Exclusive end, YYYY-MM-DD. */
  endStr: string;
  start: Date;
  end: Date;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The current calendar month, matching how the CEO route derives its window.
 *
 * Local server time, deliberately — the CEO route uses `new Date()` the same
 * way, and a mirror that silently used a different timezone would disagree with
 * the dashboard for a few hours around every month boundary.
 */
export function currentMonthWindow(now = new Date()): MonthWindow {
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = new Date(y, m, 1);
  const end = new Date(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1);
  return {
    start,
    end,
    startStr: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-01`,
    endStr: `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-01`,
  };
}

export interface CeoBusinessMetrics {
  leads_created: number;
  leads_converted: number;
  dealers_onboarded: number;
  /** INR rupees, as the CEO tiles show them. */
  revenue: number;
  outstanding: number;
  buyback_submitted: number;
  buyback_completed: number;
  active_iot_devices: number;
}

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Every business number the Ops Console mirrors, for one month window.
 *
 * The buyback and IoT figures have no CEO-tile equivalent — they come from the
 * registry's list in the Ops plan — so they are defined here for the first
 * time rather than mirrored. Their source tables are noted inline.
 */
export async function getCeoBusinessMetrics(
  window: MonthWindow = currentMonthWindow(),
): Promise<CeoBusinessMetrics> {
  const { start, end, startStr, endStr } = window;

  const [
    leadsAgg,
    dealersAgg,
    revenueAgg,
    outstandingAgg,
    buybackAgg,
    iotAgg,
  ] = await Promise.all([
    // Mirrors conversionResultQ. COUNT(*) over the window; conversions are the
    // exact 'qualified' status the dashboard filters on.
    db
      .select({
        total_leads: sql<number>`COUNT(*)`,
        conversions: sql<number>`COUNT(*) FILTER (WHERE current_status = 'qualified')`,
      })
      .from(dealerLeads)
      .where(and(gte(dealerLeads.created_at, start), lt(dealerLeads.created_at, end))),

    db
      .select({ onboarded: sql<number>`COUNT(*)` })
      .from(dealers)
      .where(and(gte(dealers.created_at, start), lt(dealers.created_at, end))),

    // Mirrors zohoRevenueQ — void-only exclusion, drafts counted.
    db
      .select({ revenue: sql<string>`COALESCE(SUM(${zohoInvoices.total}), 0)` })
      .from(zohoInvoices)
      .where(
        and(
          gte(zohoInvoices.invoice_date, startStr),
          lt(zohoInvoices.invoice_date, endStr),
          sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void'))`,
        ),
      ),

    // Mirrors outstandingAggQ. NOT windowed: a receivable is outstanding today
    // regardless of which month it was invoiced in, which is why the CEO route
    // has no date filter here either.
    db
      .select({ outstanding: sql<string>`COALESCE(SUM(${zohoInvoices.balance}), 0)` })
      .from(zohoInvoices)
      .where(
        sql`${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('paid', 'void', 'draft')`,
      ),

    // Buyback: submitted is stamped on the request (there is no status column
    // on buyback_requests); completed is a CLOSED deal. Statuses are uppercase
    // in this table, unlike everywhere else in the schema.
    //
    // ISO STRINGS, NOT Date OBJECTS. The Drizzle query builder serialises a JS
    // Date for you; a raw sql`` template hands the value straight to
    // postgres-js, which throws "The string argument must be of type string
    // ... Received an instance of Date". The ::timestamptz cast keeps the
    // comparison typed rather than leaving Postgres to infer it from unknown.
    db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM buyback_requests
           WHERE submitted_at >= ${start.toISOString()}::timestamptz
             AND submitted_at <  ${end.toISOString()}::timestamptz)::int AS submitted,
        (SELECT COUNT(*) FROM buyback_deals
           WHERE status = 'CLOSED'
             AND updated_at >= ${start.toISOString()}::timestamptz
             AND updated_at <  ${end.toISOString()}::timestamptz)::int AS completed
    `),

    // "Active" = reported telemetry in the last 24h, not a flag on the row.
    // device_status is cached state that a dead ingest pipeline leaves stale at
    // 'online' forever — which is the exact failure this metric must catch.
    db.execute(sql`
      SELECT COUNT(*)::int AS active FROM iot_devices
      WHERE last_seen > NOW() - INTERVAL '24 hours'
    `),
  ]);

  const buyback = (buybackAgg as unknown as Array<Record<string, unknown>>)[0];
  const iot = (iotAgg as unknown as Array<Record<string, unknown>>)[0];

  return {
    leads_created: n(leadsAgg[0]?.total_leads),
    leads_converted: n(leadsAgg[0]?.conversions),
    dealers_onboarded: n(dealersAgg[0]?.onboarded),
    revenue: n(revenueAgg[0]?.revenue),
    outstanding: n(outstandingAgg[0]?.outstanding),
    buyback_submitted: n(buyback?.submitted),
    buyback_completed: n(buyback?.completed),
    active_iot_devices: n(iot?.active),
  };
}
