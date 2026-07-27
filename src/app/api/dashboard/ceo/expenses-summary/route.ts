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
import { approvedExpenseInWindow } from "@/lib/dashboard/salesWindow";

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

    const sp = req.nextUrl.searchParams;
    const monthParam = sp.get("month");
    const yearParam = sp.get("year");
    const period = sp.get("period") || "mtd";

    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const curYear = now.getFullYear();
    const curMonth = now.getMonth(); // 0-indexed

    let startStr: string;
    let endStr: string | null = null;
    let label: string;
    let resolvedPeriod: string;

    const monthMatch = monthParam?.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) {
      const y = Number(monthMatch[1]);
      const mo = Number(monthMatch[2]); // 1-indexed
      if (mo < 1 || mo > 12) {
        return NextResponse.json(
          { success: false, error: { message: "invalid month" } },
          { status: 400 },
        );
      }
      startStr = `${y}-${pad2(mo)}-01`;
      const ey = mo === 12 ? y + 1 : y;
      const em = mo === 12 ? 1 : mo + 1;
      endStr = `${ey}-${pad2(em)}-01`;
      resolvedPeriod = monthParam!;
      label = new Date(`${startStr}T00:00:00`).toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric",
      });
    } else if (yearParam) {
      // Whole calendar year — total of all its months (Jan–Dec).
      const y = Number(yearParam);
      if (!/^\d{4}$/.test(yearParam) || y < 2000 || y > 2100) {
        return NextResponse.json(
          { success: false, error: { message: "invalid year" } },
          { status: 400 },
        );
      }
      startStr = `${y}-01-01`;
      endStr = `${y + 1}-01-01`;
      resolvedPeriod = `year-${y}`;
      label = `Year ${y}`;
    } else if (period === "fy") {
      const fyStartYear = curMonth >= 3 ? curYear : curYear - 1;
      startStr = `${fyStartYear}-04-01`;
      endStr = null;
      resolvedPeriod = "fy";
      label = `FY since 1 Apr ${fyStartYear}`;
    } else {
      startStr = `${curYear}-${pad2(curMonth + 1)}-01`;
      const ey = curMonth === 11 ? curYear + 1 : curYear;
      const em = curMonth === 11 ? 1 : curMonth + 2;
      endStr = `${ey}-${pad2(em)}-01`;
      resolvedPeriod = "mtd";
      label = new Date(`${startStr}T00:00:00`).toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric",
      });
    }

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
        period: resolvedPeriod,
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
