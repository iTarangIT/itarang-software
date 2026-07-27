/**
 * GET /api/dashboard/ceo/snapshot-summary
 *
 * Returns the Business Snapshot figures (Purchases from OEM, Sales to Dealer,
 * Other Expenses, and Net) for a chosen window so the CEO can look up a past
 * month or the financial year without a full dashboard refetch.
 *
 *   ?month=YYYY-MM   → that calendar month
 *   ?period=mtd      → current month (default)
 *   ?period=fy       → financial year to date (since 1 Apr)
 *
 * Each aggregate mirrors the exact filter the main dashboard uses
 * (`/api/dashboard/[role]`) so the default "This month" window reconciles with
 * the headline tiles:
 *   - purchases    → SUM(inventory.final_amount)   by oem_invoice_date
 *   - sales        → SUM(zoho_invoices.total)      by invoice_date, non-void (Zoho only)
 *   - otherExpenses→ SUM(expense_submissions.amount) by approved_at, status='approved'
 */
import { NextRequest, NextResponse } from "next/server";
import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions, inventory, zohoInvoices } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { approvedExpenseInWindow, resolveWindow } from "@/lib/dashboard/salesWindow";

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
    const period = sp.get("period") || "mtd";

    // Reject a malformed ?month= rather than silently falling back to MTD.
    if (monthParam && !/^(\d{4})-(0[1-9]|1[0-2])$/.test(monthParam)) {
      return NextResponse.json(
        { success: false, error: { message: "invalid month" } },
        { status: 400 },
      );
    }

    // [start, end) local date strings; endStr is null for the open-ended FY.
    const { startStr, endStr } = resolveWindow(monthParam, period);

    // Human label + the period token echoed back to the client.
    let resolvedPeriod: string;
    let label: string;
    if (monthParam) {
      resolvedPeriod = monthParam;
      label = new Date(`${startStr}T00:00:00`).toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric",
      });
    } else if (period === "fy") {
      resolvedPeriod = "fy";
      label = "Financial year";
    } else {
      resolvedPeriod = "mtd";
      label = "This month";
    }

    // purchases — inventory.oem_invoice_date is a timestamptz; compare ::date.
    const purchaseConds = [gte(inventory.oem_invoice_date, sql`${startStr}::date`)];
    if (endStr) purchaseConds.push(lt(inventory.oem_invoice_date, sql`${endStr}::date`));

    // sales — zoho_invoices.invoice_date is a date column; compare the strings.
    const salesConds = [
      gte(zohoInvoices.invoice_date, startStr),
      sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void'))`,
    ];
    if (endStr) salesConds.push(lt(zohoInvoices.invoice_date, endStr));

    // expenses — approved only, windowed on the expense's effective date
    // (E-214: COALESCE(expense_date, approved_at::date)) so `net` below is
    // computed against the same figure the Expenses card shows.
    const expenseWhere = approvedExpenseInWindow(startStr, endStr);

    const [purchaseAgg, salesAgg, expenseAgg] = await Promise.all([
      db
        .select({ total: sql<string>`COALESCE(SUM(${inventory.final_amount}), 0)` })
        .from(inventory)
        .where(and(...purchaseConds)),
      db
        .select({ total: sql<string>`COALESCE(SUM(${zohoInvoices.total}), 0)` })
        .from(zohoInvoices)
        .where(and(...salesConds)),
      db
        .select({ total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)` })
        .from(expenseSubmissions)
        .where(expenseWhere),
    ]);

    const purchases = Number(purchaseAgg[0]?.total || 0);
    const sales = Number(salesAgg[0]?.total || 0);
    const otherExpenses = Number(expenseAgg[0]?.total || 0);

    return NextResponse.json({
      success: true,
      data: {
        purchases,
        sales,
        otherExpenses,
        net: sales - purchases - otherExpenses,
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
