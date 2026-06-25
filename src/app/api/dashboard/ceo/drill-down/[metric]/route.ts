/**
 * E-172 — GET /api/dashboard/ceo/drill-down/[metric]
 *
 * Itemized rows behind a CEO dashboard headline number, reusing the exact same
 * filters as the main dashboard (`/api/dashboard/[role]`) so a drill-down total
 * always reconciles with the card it expands.
 *
 *   metric ∈ purchases | sales | expenses | inventory | outstanding
 *   ?period=mtd|fy  or  ?month=YYYY-MM   (inventory & outstanding ignore period)
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions, inventory, users, zohoInvoices } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "sales_head"]);
const METRICS = new Set(["purchases", "sales", "expenses", "inventory", "outstanding"]);
const ROW_CAP = 500;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ metric: string }> },
) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const { metric } = await params;
    if (!METRICS.has(metric)) {
      return NextResponse.json(
        { success: false, error: { message: "unknown metric" } },
        { status: 400 },
      );
    }

    const sp = req.nextUrl.searchParams;
    const monthParam = sp.get("month");
    const period = sp.get("period") || "mtd";

    // Resolve the [start, end) window as local date strings.
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const curYear = now.getFullYear();
    const curMonth = now.getMonth();

    let startStr: string;
    let endStr: string | null = null;
    const monthMatch = monthParam?.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) {
      const y = Number(monthMatch[1]);
      const mo = Number(monthMatch[2]);
      startStr = `${y}-${pad2(mo)}-01`;
      const ey = mo === 12 ? y + 1 : y;
      const em = mo === 12 ? 1 : mo + 1;
      endStr = `${ey}-${pad2(em)}-01`;
    } else if (period === "fy") {
      const fyStartYear = curMonth >= 3 ? curYear : curYear - 1;
      startStr = `${fyStartYear}-04-01`;
      endStr = null;
    } else {
      startStr = `${curYear}-${pad2(curMonth + 1)}-01`;
      const ey = curMonth === 11 ? curYear + 1 : curYear;
      const em = curMonth === 11 ? 1 : curMonth + 2;
      endStr = `${ey}-${pad2(em)}-01`;
    }

    let rows: Record<string, unknown>[] = [];
    let total = 0;

    if (metric === "purchases") {
      // inventory.oem_invoice_date is a timestamptz; compare against date strings.
      const conds = [gte(inventory.oem_invoice_date, sql`${startStr}::date`)];
      if (endStr) conds.push(lt(inventory.oem_invoice_date, sql`${endStr}::date`));
      rows = await db
        .select({
          oem_invoice_number: inventory.oem_invoice_number,
          oem_name: inventory.oem_name,
          serial_number: inventory.serial_number,
          model_type: inventory.model_type,
          oem_invoice_date: inventory.oem_invoice_date,
          final_amount: inventory.final_amount,
          status: inventory.status,
        })
        .from(inventory)
        .where(and(...conds))
        .orderBy(desc(inventory.oem_invoice_date))
        .limit(ROW_CAP);
      total = rows.reduce((s, r) => s + Number(r.final_amount || 0), 0);
    } else if (metric === "sales") {
      const conds = [
        gte(zohoInvoices.invoice_date, startStr),
        sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void', 'draft'))`,
      ];
      if (endStr) conds.push(lt(zohoInvoices.invoice_date, endStr));
      rows = await db
        .select({
          invoice_number: zohoInvoices.invoice_number,
          customer_name: zohoInvoices.customer_name,
          invoice_date: zohoInvoices.invoice_date,
          total: zohoInvoices.total,
          status: zohoInvoices.status,
        })
        .from(zohoInvoices)
        .where(and(...conds))
        .orderBy(desc(zohoInvoices.invoice_date))
        .limit(ROW_CAP);
      total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    } else if (metric === "expenses") {
      const conds = [
        eq(expenseSubmissions.status, "approved"),
        gte(expenseSubmissions.approved_at, sql`${startStr}::date`),
      ];
      if (endStr) conds.push(lt(expenseSubmissions.approved_at, sql`${endStr}::date`));
      rows = await db
        .select({
          invoice_number: expenseSubmissions.invoice_number,
          vendor: expenseSubmissions.vendor,
          department: expenseSubmissions.department,
          project_tag: expenseSubmissions.project_tag,
          amount: expenseSubmissions.amount,
          expense_date: expenseSubmissions.expense_date,
          bill_url: expenseSubmissions.bill_url,
          submitter_name: users.name,
        })
        .from(expenseSubmissions)
        .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
        .where(and(...conds))
        .orderBy(desc(expenseSubmissions.approved_at))
        .limit(ROW_CAP);
      total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    } else if (metric === "inventory") {
      rows = await db
        .select({
          serial_number: inventory.serial_number,
          model_type: inventory.model_type,
          oem_name: inventory.oem_name,
          status: inventory.status,
          final_amount: inventory.final_amount,
        })
        .from(inventory)
        .orderBy(desc(inventory.final_amount))
        .limit(ROW_CAP);
      total = rows.reduce((s, r) => s + Number(r.final_amount || 0), 0);
    } else if (metric === "outstanding") {
      rows = await db
        .select({
          invoice_number: zohoInvoices.invoice_number,
          customer_name: zohoInvoices.customer_name,
          invoice_date: zohoInvoices.invoice_date,
          total: zohoInvoices.total,
          balance: zohoInvoices.balance,
          status: zohoInvoices.status,
        })
        .from(zohoInvoices)
        .where(
          and(
            sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('paid', 'void', 'draft'))`,
            sql`COALESCE(${zohoInvoices.balance}, 0) > 0`,
          ),
        )
        .orderBy(desc(zohoInvoices.balance))
        .limit(ROW_CAP);
      total = rows.reduce((s, r) => s + Number(r.balance || 0), 0);
    }

    return NextResponse.json({
      success: true,
      data: { metric, total, rows },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
