/**
 * E-219 — GET /api/dashboard/ceo/overview
 *
 * The CEO landing page's headline figures, all resolved against ONE window so
 * the cards, the drill-down and the chart cannot disagree about which days they
 * describe:
 *
 *   realization — revenue, expense, outstanding and revenue − expense
 *   leads       — leads created in the window and how many qualified
 *   buyback     — buyback requests submitted vs completed
 *   chart       — the same revenue/expense/realization, bucketed over time
 *
 *   ?period=mtd | ytd | fy | inception   (default mtd)
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD       explicit range, `to` inclusive
 *   ?granularity=day | week | month      overrides the span-derived default
 *
 * WHY GREEN KM IS NOT HERE
 *   Green KM reads the IoT Postgres, which is reachable only over an SSH
 *   tunnel and is routinely down. Folding it into this handler would put every
 *   card behind an 8s connect timeout and then a 500. It lives in its own route
 *   (./green-km) so a dead tunnel costs one card instead of the page.
 *
 * WHY BUYBACK IS WRAPPED IN A GUARD
 *   E-185_buyback_core is applied on db-1 and sandbox but NOT on production —
 *   see drizzle/MIGRATION_CHECKLIST.md, where both prod columns sit unticked.
 *   Querying buyback_requests there raises 42P01 undefined_table. Unguarded,
 *   that one missing table would take the whole CEO dashboard down on prod, so
 *   the card reports itself unavailable instead.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  buybackDeals,
  buybackRequests,
  dealerLeads,
  expenseSubmissions,
  zohoInvoices,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
  approvedExpenseInWindow,
  defaultGranularity,
  expenseEffectiveDate,
  resolveWindowParams,
  type TrendGranularity,
} from "@/lib/dashboard/salesWindow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

/** Deals that reached the end of the money leg. Anything earlier is in flight. */
const BUYBACK_COMPLETED = ["SETTLED", "CLOSED"] as const;

/**
 * The completed set as a SQL literal list. Built from the constant above rather
 * than hand-written into the query, so the definition of "completed" has one
 * home. Safe for sql.raw: the values are a hardcoded tuple, never user input.
 */
const BUYBACK_COMPLETED_SQL = sql.raw(
  BUYBACK_COMPLETED.map((s) => `'${s}'`).join(", "),
);

/**
 * Postgres "relation does not exist". The buyback tables are genuinely absent
 * on production, so this is an expected environment state rather than a bug —
 * every other error still propagates.
 */
function isUndefinedTable(e: unknown): boolean {
  return (e as { code?: string })?.code === "42P01";
}

/**
 * Year-qualified for the long windows so a chart spanning more than one year
 * never shows two identical "Jul" columns.
 */
function bucketLabelFormat(granularity: TrendGranularity): string {
  return granularity === "month" ? "Mon YYYY" : "DD Mon";
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const sp = req.nextUrl.searchParams;
    const resolved = resolveWindowParams(sp);
    if (!resolved.ok) {
      return NextResponse.json(
        { success: false, error: { message: resolved.error } },
        { status: 400 },
      );
    }
    const { startStr, endStr, period, label } = resolved.window;

    const granRaw = (sp.get("granularity") || "").toLowerCase();
    const granularity: TrendGranularity = (
      ["day", "week", "month"] as const
    ).includes(granRaw as TrendGranularity)
      ? (granRaw as TrendGranularity)
      : defaultGranularity(resolved.window);

    // ── Revenue ──────────────────────────────────────────────────────────────
    // Void excluded, drafts counted — the rule the CEO signed off on for the
    // Revenue card, kept identical here so the two never disagree.
    const notVoid = sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void'))`;
    const invoiceWindow = [notVoid];
    if (startStr) invoiceWindow.push(gte(zohoInvoices.invoice_date, startStr));
    if (endStr) invoiceWindow.push(lt(zohoInvoices.invoice_date, endStr));

    const revenueQ = db
      .select({ total: sql<string>`COALESCE(SUM(${zohoInvoices.total}), 0)` })
      .from(zohoInvoices)
      .where(and(...invoiceWindow));

    // ── Outstanding ──────────────────────────────────────────────────────────
    // Windowed on invoice_date, unlike the standalone Outstanding Credits card
    // which is an all-time snapshot. Inside the Realization drill-down it sits
    // beside a windowed revenue and a windowed expense, and a receivable from
    // outside the period would not belong next to either.
    const outstandingWindow = [
      sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('paid', 'void', 'draft'))`,
      sql`COALESCE(${zohoInvoices.balance}, 0) > 0`,
    ];
    if (startStr) outstandingWindow.push(gte(zohoInvoices.invoice_date, startStr));
    if (endStr) outstandingWindow.push(lt(zohoInvoices.invoice_date, endStr));

    const outstandingQ = db
      .select({ total: sql<string>`COALESCE(SUM(${zohoInvoices.balance}), 0)` })
      .from(zohoInvoices)
      .where(and(...outstandingWindow));

    // ── Expense ──────────────────────────────────────────────────────────────
    // Approved submissions only, windowed on COALESCE(expense_date,
    // approved_at::date) per E-216, so Realization reconciles to the rupee with
    // /ceo/expenses rather than merely looking close.
    const expenseWhere = approvedExpenseInWindow(startStr, endStr);
    const expenseQ = db
      .select({ total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)` })
      .from(expenseSubmissions)
      .where(expenseWhere);

    // ── Leads ────────────────────────────────────────────────────────────────
    const leadWindow = [];
    if (startStr) leadWindow.push(gte(dealerLeads.created_at, sql`${startStr}::date`));
    if (endStr) leadWindow.push(lt(dealerLeads.created_at, sql`${endStr}::date`));
    const leadsQ = db
      .select({
        total: sql<number>`COUNT(*)`,
        converted: sql<number>`COUNT(*) FILTER (WHERE ${dealerLeads.current_status} = 'qualified')`,
      })
      .from(dealerLeads)
      .where(leadWindow.length ? and(...leadWindow) : undefined);

    // ── Chart series ─────────────────────────────────────────────────────────
    // The bucket expression is inlined with sql.raw so the SAME text appears in
    // SELECT, GROUP BY and ORDER BY — a bound parameter emits different
    // placeholders and Postgres then rejects the column as "not grouped".
    // `granularity` is whitelisted above, so nothing user-supplied reaches raw.
    const labelFmt = bucketLabelFormat(granularity);

    const revenueBucket = sql.raw(
      `date_trunc('${granularity}', "zoho_invoices"."invoice_date")`,
    );
    const revenueSeriesQ = db
      .select({
        bucket: sql<string>`${revenueBucket}`,
        name: sql<string>`to_char(${revenueBucket}, ${labelFmt})`,
        revenue: sql<string>`COALESCE(SUM(${zohoInvoices.total}), 0)`,
      })
      .from(zohoInvoices)
      .where(and(...invoiceWindow))
      .groupBy(revenueBucket)
      .orderBy(revenueBucket);

    // Same effective-date expression the expense total uses, so a bar and the
    // card above it are computed from one definition of "when this was spent".
    const expenseBucket = sql`date_trunc(${sql.raw(`'${granularity}'`)}, ${expenseEffectiveDate()})`;
    const expenseSeriesQ = db
      .select({
        bucket: sql<string>`${expenseBucket}`,
        name: sql<string>`to_char(${expenseBucket}, ${labelFmt})`,
        expense: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
      })
      .from(expenseSubmissions)
      .where(expenseWhere)
      .groupBy(expenseBucket)
      .orderBy(expenseBucket);

    // ── Buyback (guarded — see header) ───────────────────────────────────────
    const buybackSubmittedWindow = [sql`${buybackRequests.submitted_at} IS NOT NULL`];
    if (startStr) {
      buybackSubmittedWindow.push(gte(buybackRequests.submitted_at, sql`${startStr}::date`));
    }
    if (endStr) {
      buybackSubmittedWindow.push(lt(buybackRequests.submitted_at, sql`${endStr}::date`));
    }

    const buybackP = (async () => {
      try {
        const [row] = await db
          .select({
            submitted: sql<number>`COUNT(*)`,
            completed: sql<number>`COUNT(*) FILTER (WHERE ${buybackDeals.status} IN (${BUYBACK_COMPLETED_SQL}))`,
          })
          .from(buybackRequests)
          .leftJoin(buybackDeals, sql`${buybackDeals.request_id} = ${buybackRequests.id}`)
          .where(and(...buybackSubmittedWindow));
        return {
          available: true as const,
          submitted: Number(row?.submitted || 0),
          completed: Number(row?.completed || 0),
        };
      } catch (e) {
        if (!isUndefinedTable(e)) throw e;
        // Expected on production until E-185_buyback_core is applied there.
        console.warn("[ceo/overview] buyback tables absent:", errorMessage(e));
        return { available: false as const, submitted: 0, completed: 0 };
      }
    })();

    const [
      [revenueAgg],
      [outstandingAgg],
      [expenseAgg],
      [leadsAgg],
      revenueSeries,
      expenseSeries,
      buyback,
    ] = await Promise.all([
      revenueQ,
      outstandingQ,
      expenseQ,
      leadsQ,
      revenueSeriesQ,
      expenseSeriesQ,
      buybackP,
    ]);

    const revenue = Number(revenueAgg?.total || 0);
    const expense = Number(expenseAgg?.total || 0);
    const outstanding = Number(outstandingAgg?.total || 0);

    // Revenue and expense are bucketed by separate queries, so a period with
    // spend but no invoices (or the reverse) exists in only one of them. Merge
    // on the bucket key and keep chronological order — dropping the unmatched
    // side would silently hide a month of expenses.
    const byBucket = new Map<
      string,
      { bucket: string; name: string; revenue: number; expense: number }
    >();
    const keyOf = (b: unknown) =>
      b instanceof Date ? b.toISOString() : String(b);

    for (const r of revenueSeries) {
      const key = keyOf(r.bucket);
      byBucket.set(key, {
        bucket: key,
        name: r.name,
        revenue: Number(r.revenue || 0),
        expense: 0,
      });
    }
    for (const e of expenseSeries) {
      const key = keyOf(e.bucket);
      const existing = byBucket.get(key);
      if (existing) existing.expense = Number(e.expense || 0);
      else {
        byBucket.set(key, {
          bucket: key,
          name: e.name,
          revenue: 0,
          expense: Number(e.expense || 0),
        });
      }
    }

    const chart = Array.from(byBucket.values())
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
      .map((row) => ({
        name: row.name,
        revenue: row.revenue,
        expense: row.expense,
        realization: row.revenue - row.expense,
      }));

    return NextResponse.json({
      success: true,
      data: {
        period,
        label,
        granularity,
        realization: {
          revenue,
          expense,
          outstanding,
          realization: revenue - expense,
        },
        leads: {
          total: Number(leadsAgg?.total || 0),
          converted: Number(leadsAgg?.converted || 0),
        },
        buyback,
        chart,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
