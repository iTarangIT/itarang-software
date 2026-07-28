/**
 * E-218 — GET /api/dashboard/ceo/expenses-buckets
 *
 * The two questions the flat Expenses card could not answer:
 *
 *   "where did the money go"      → `buckets`, the selected window split four ways
 *   "how does this month compare" → `trend`, the same split for the trailing
 *                                   six months, ending on the selected month
 *
 * Takes the same window params as expenses-summary (?month / ?year / ?period),
 * resolved by the same helper, so the tiles can never disagree with the total
 * on the card above them.
 *
 * Rows whose bucket is still NULL (pre-E-218, backfill not yet run) are
 * reported under the "unclassified" key rather than being dropped or folded
 * into "others" — see UNCLASSIFIED_BUCKET_KEY. That keeps the parts summing to
 * the card's total, which is the property that makes the tiles trustworthy.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
  approvedExpenseInWindow,
  expenseEffectiveDate,
  resolveWindowParams,
} from "@/lib/dashboard/salesWindow";
import {
  EXPENSE_BUCKETS,
  UNCLASSIFIED_BUCKET_KEY,
  expenseBucketLabel,
  expenseDepartmentLabel,
} from "@/lib/expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "sales_head"]);

/** Bars on the trend chart. Six reads as a quarter-over-quarter shape without
 *  the bars getting too thin to compare on a dashboard-width card. */
const TREND_MONTHS = 6;

/**
 * Fixed render order: the taxonomy's own order, then unclassified last.
 *
 * The stacking order of the bars comes from this array, so it must NOT be
 * sorted by value — a chart whose segments reorder month to month is unreadable
 * precisely when it matters, which is when the mix has changed.
 */
const SERIES_KEYS = [
  ...EXPENSE_BUCKETS.map((b) => b.value as string),
  UNCLASSIFIED_BUCKET_KEY,
];

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Month arithmetic on a {y, m} pair — m is 1-indexed. */
function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const zero = y * 12 + (m - 1) + delta;
  return { y: Math.floor(zero / 12), m: (zero % 12) + 1 };
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

    const resolved = resolveWindowParams(req.nextUrl.searchParams);
    if (!resolved.ok) {
      return NextResponse.json(
        { success: false, error: { message: resolved.error } },
        { status: 400 },
      );
    }
    const { startStr, endStr, period, label } = resolved.window;

    const monthKey = sql<string>`to_char(${expenseEffectiveDate()}, 'YYYY-MM')`;

    // Group on the raw column and fold NULL -> "unclassified" in TS. Doing the
    // COALESCE in SQL would bind the fallback as a parameter, and the same
    // chunk in SELECT and GROUP BY serialises to $1 and $2 — which Postgres
    // does not consider the same expression, so it rejects the grouping.
    const groupedBucket = (value: string | null) => value ?? UNCLASSIFIED_BUCKET_KEY;

    // --- the selected window, split by bucket -------------------------------
    const windowRows = await db
      .select({
        bucket: expenseSubmissions.bucket,
        total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
      })
      .from(expenseSubmissions)
      .where(approvedExpenseInWindow(startStr, endStr))
      .groupBy(expenseSubmissions.bucket);

    const windowTotals = new Map(
      windowRows.map((r) => [groupedBucket(r.bucket), Number(r.total || 0)]),
    );
    const total = [...windowTotals.values()].reduce((a, b) => a + b, 0);

    const buckets = SERIES_KEYS.map((key) => {
      const value = windowTotals.get(key) ?? 0;
      return {
        bucket: key,
        label: expenseBucketLabel(key),
        total: value,
        // Share of the window, so the tile can print "32% of spend" without the
        // client re-deriving a denominator that might not match ours.
        share: total > 0 ? value / total : 0,
      };
    });

    // --- the same window, split by department -------------------------------
    // The second question a tile raises is "whose spend is that" — department
    // is E-106's answer and is already on every row, so it costs one more
    // GROUP BY rather than another screen.
    const deptRows = await db
      .select({
        department: expenseSubmissions.department,
        total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
      })
      .from(expenseSubmissions)
      .where(approvedExpenseInWindow(startStr, endStr))
      .groupBy(expenseSubmissions.department);

    const departments = deptRows
      .map((r) => ({
        department: r.department ?? "unassigned",
        label: expenseDepartmentLabel(r.department),
        total: Number(r.total || 0),
      }))
      .filter((d) => d.total > 0)
      .sort((a, b) => b.total - a.total);

    // --- trailing months, same split ---------------------------------------
    // The last month the trend shows is the last month the SELECTED window
    // covers, capped at the current month: an open-ended FY or a year still in
    // progress should not draw empty bars for months that have not happened.
    const now = new Date();
    const current = { y: now.getFullYear(), m: now.getMonth() + 1 };
    const windowLast = endStr
      ? // endStr is exclusive, so the last included month is the one before it.
        addMonths(Number(endStr.slice(0, 4)), Number(endStr.slice(5, 7)), -1)
      : current;
    const anchor =
      windowLast.y * 12 + windowLast.m > current.y * 12 + current.m
        ? current
        : windowLast;

    const trendStart = addMonths(anchor.y, anchor.m, -(TREND_MONTHS - 1));
    const trendEnd = addMonths(anchor.y, anchor.m, 1); // exclusive

    const trendRows = await db
      .select({
        month: monthKey,
        bucket: expenseSubmissions.bucket,
        total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
      })
      .from(expenseSubmissions)
      .where(
        approvedExpenseInWindow(
          `${trendStart.y}-${pad2(trendStart.m)}-01`,
          `${trendEnd.y}-${pad2(trendEnd.m)}-01`,
        ),
      )
      .groupBy(monthKey, expenseSubmissions.bucket);

    // Build the month axis from the range, not from the rows: a month with no
    // spend must still appear as an empty slot, otherwise a gap in the ledger
    // silently becomes a missing bar and the trend reads as continuous.
    const months: string[] = [];
    for (let i = 0; i < TREND_MONTHS; i++) {
      const { y, m } = addMonths(trendStart.y, trendStart.m, i);
      months.push(`${y}-${pad2(m)}`);
    }

    const byMonthBucket = new Map<string, number>();
    for (const r of trendRows) {
      byMonthBucket.set(
        `${r.month}|${groupedBucket(r.bucket)}`,
        Number(r.total || 0),
      );
    }

    const series = SERIES_KEYS.map((key) => ({
      bucket: key,
      label: expenseBucketLabel(key),
      totals: months.map((mo) => byMonthBucket.get(`${mo}|${key}`) ?? 0),
    }));

    return NextResponse.json({
      success: true,
      data: {
        period,
        label,
        total,
        buckets,
        departments,
        trend: {
          months,
          monthLabels: months.map((mo) =>
            new Date(`${mo}-01T00:00:00`).toLocaleDateString("en-IN", {
              month: "short",
            }),
          ),
          series,
        },
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
