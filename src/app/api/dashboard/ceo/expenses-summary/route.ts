/**
 * E-172 — GET /api/dashboard/ceo/expenses-summary
 *
 * Returns the approved-expense total for a chosen window so the CEO Expenses
 * card can switch between months / the financial year without a full dashboard
 * refetch. Uses the same filter as the main CEO dashboard: status='approved'
 * with the expense's effective date inside the window.
 *
 * E-216 — that effective date is COALESCE(expense_date, approved_at::date),
 * not approved_at alone. For an AI-extracted row approved_at is the moment
 * somebody imported it, so a scan of a Drive folder full of historic invoices
 * would otherwise pile a year of spend into whichever month the scan ran.
 *
 *   ?month=YYYY-MM   → that calendar month
 *   ?period=mtd      → current month (default)
 *   ?period=fy       → financial year to date (since 1 Apr)
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "sales_head"]);

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

    // E-216 — windowed on the invoice's own date, not approved_at (= import
    // time). A bill dated March counts in March however late it was scanned.
    const [agg] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
      })
      .from(expenseSubmissions)
      .where(approvedExpenseInWindow(startStr, endStr));

    return NextResponse.json({
      success: true,
      data: {
        total: Number(agg?.total || 0),
        period,
        label,
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
