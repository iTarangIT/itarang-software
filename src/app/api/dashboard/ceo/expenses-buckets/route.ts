/**
 * E-218 — GET /api/dashboard/ceo/expenses-buckets
 *
 * Answers "where did the money go" for the Expenses drill-down: the selected
 * window split by `buckets` and by `departments`, each carrying both a rupee
 * total and an invoice `count`.
 *
 * Takes the same window params as expenses-summary (?month / ?year / ?period /
 * ?from&?to), resolved by the same helper, so these can never disagree with the
 * total on the card above them.
 *
 * Rows whose bucket is still NULL (pre-E-218, backfill not yet run) are
 * reported under the "unclassified" key rather than being dropped or folded
 * into "others" — see UNCLASSIFIED_BUCKET_KEY. That keeps the parts summing to
 * the card's total, which is the property that makes the split trustworthy.
 *
 * E-219 — the trailing-six-month `trend` this used to return is gone, along
 * with the stacked bar chart that was its only consumer. The drill-down now
 * filters by month and by date range directly, so a fixed six-month window
 * answered a question nobody was asking any more and cost an extra grouped
 * scan on every open.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
  approvedExpenseInWindow,
  resolveWindowParams,
} from "@/lib/dashboard/salesWindow";
import {
  EXPENSE_BUCKETS,
  UNASSIGNED_DEPARTMENT_KEY,
  UNCLASSIFIED_BUCKET_KEY,
  expenseBucketLabel,
  expenseDepartmentLabel,
} from "@/lib/expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "sales_head"]);

/**
 * Fixed order: the taxonomy's own order, then unclassified last.
 *
 * Deliberately NOT sorted by value — this is the order the Bucket dropdown
 * lists its options in, and a filter whose options reshuffle whenever the
 * window changes is one you have to re-read every time.
 */
const SERIES_KEYS = [
  ...EXPENSE_BUCKETS.map((b) => b.value as string),
  UNCLASSIFIED_BUCKET_KEY,
];

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
        // E-219 — the dropdowns label each option with how many invoices it
        // would leave in the list, so the cost of a filter is visible before
        // it is applied. Counted here rather than derived from the fetched
        // rows, which are capped at 500 and would undercount silently.
        count: sql<number>`COUNT(*)`,
      })
      .from(expenseSubmissions)
      .where(approvedExpenseInWindow(startStr, endStr))
      .groupBy(expenseSubmissions.bucket);

    const windowTotals = new Map(
      windowRows.map((r) => [groupedBucket(r.bucket), Number(r.total || 0)]),
    );
    const windowCounts = new Map(
      windowRows.map((r) => [groupedBucket(r.bucket), Number(r.count || 0)]),
    );
    const total = [...windowTotals.values()].reduce((a, b) => a + b, 0);
    const count = [...windowCounts.values()].reduce((a, b) => a + b, 0);

    const buckets = SERIES_KEYS.map((key) => {
      const value = windowTotals.get(key) ?? 0;
      return {
        bucket: key,
        label: expenseBucketLabel(key),
        total: value,
        count: windowCounts.get(key) ?? 0,
        // Share of the window, so the client can print "32% of spend" without
        // re-deriving a denominator that might not match ours.
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
        count: sql<number>`COUNT(*)`,
      })
      .from(expenseSubmissions)
      .where(approvedExpenseInWindow(startStr, endStr))
      .groupBy(expenseSubmissions.department);

    // "unassigned" is the synthetic key for a NULL department — the drill-down
    // filter reads it back and matches on IS NULL, so a row with no department
    // stays reachable instead of being filterable only by picking "all".
    const departments = deptRows
      .map((r) => ({
        department: r.department ?? UNASSIGNED_DEPARTMENT_KEY,
        label: expenseDepartmentLabel(r.department),
        total: Number(r.total || 0),
        count: Number(r.count || 0),
      }))
      .filter((d) => d.total > 0)
      .sort((a, b) => b.total - a.total);

    return NextResponse.json({
      success: true,
      data: {
        period,
        label,
        total,
        count,
        buckets,
        departments,
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
