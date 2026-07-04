/**
 * E-105 — GET /api/admin/zoho/invoices
 *
 * CEO-only. Lists synced Zoho invoices (one row per invoice — no Zoho-style
 * line-item explosion). Supports JSON (paginated, with summary aggregates)
 * and CSV (full filtered set, streamed) via ?format=csv.
 *
 * Query params:
 *   from        — ISO date "YYYY-MM-DD" (default: start of current month)
 *   to          — ISO date "YYYY-MM-DD" (default: today)
 *   status      — comma-separated, default = all statuses except void
 *   customer    — case-insensitive substring on customer_name
 *   limit       — JSON only (default 50, max 500)
 *   offset      — JSON only (default 0)
 *   format      — "csv" returns CSV download; anything else returns JSON
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, gte, ilike, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoInvoices } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { isCeo } from "@/lib/zoho/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_STATUSES = new Set([
  "draft",
  "sent",
  "overdue",
  "paid",
  "partially_paid",
  "void",
]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function startOfMonthISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!isCeo(user)) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN: CEO only" } },
        { status: 403 },
      );
    }

    const url = new URL(req.url);
    const from = url.searchParams.get("from") || startOfMonthISO();
    const to = url.searchParams.get("to") || todayISO();
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Invalid date format. Use YYYY-MM-DD." },
        },
        { status: 400 },
      );
    }
    const statusParam = url.searchParams.get("status");
    const customer = (url.searchParams.get("customer") || "").trim();
    const format = (url.searchParams.get("format") || "json").toLowerCase();
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") || 50), 1),
      500,
    );
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);

    const conds = [gte(zohoInvoices.invoice_date, from), lte(zohoInvoices.invoice_date, to)];
    if (statusParam) {
      const list = statusParam
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => KNOWN_STATUSES.has(s));
      if (list.length > 0) conds.push(inArray(zohoInvoices.status, list));
    } else {
      // Default: exclude void from totals (matches CEO MTD logic).
      conds.push(ne(zohoInvoices.status, "void"));
    }
    if (customer) conds.push(ilike(zohoInvoices.customer_name, `%${customer}%`));

    const where = and(...conds);

    if (format === "csv") {
      // Full set, capped at 10k rows for safety.
      const rows = await db
        .select({
          invoice_number: zohoInvoices.invoice_number,
          invoice_date: zohoInvoices.invoice_date,
          due_date: zohoInvoices.due_date,
          customer_name: zohoInvoices.customer_name,
          status: zohoInvoices.status,
          currency_code: zohoInvoices.currency_code,
          total: zohoInvoices.total,
          balance: zohoInvoices.balance,
          payment_reference: zohoInvoices.payment_reference,
        })
        .from(zohoInvoices)
        .where(where)
        .orderBy(desc(zohoInvoices.invoice_date))
        .limit(10000);

      const header = [
        "Invoice Number",
        "Invoice Date",
        "Due Date",
        "Customer",
        "Status",
        "Currency",
        "Total",
        "Balance",
        "Transaction ID",
      ];
      const lines: string[] = [header.join(",")];
      for (const r of rows) {
        lines.push(
          [
            r.invoice_number,
            r.invoice_date,
            r.due_date,
            r.customer_name,
            r.status,
            r.currency_code,
            r.total,
            r.balance,
            r.payment_reference,
          ]
            .map(csvEscape)
            .join(","),
        );
      }
      const csv = lines.join("\n");
      const filename = `zoho-invoices-${from}-to-${to}.csv`;
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    // JSON path: paginated rows + summary aggregates.
    const rows = await db
      .select()
      .from(zohoInvoices)
      .where(where)
      .orderBy(desc(zohoInvoices.invoice_date))
      .limit(limit)
      .offset(offset);

    const [aggregate] = await db
      .select({
        count: sql<number>`COUNT(*)::int`,
        total_sum: sql<string>`COALESCE(SUM(${zohoInvoices.total}), 0)`,
        balance_sum: sql<string>`COALESCE(SUM(${zohoInvoices.balance}), 0)`,
      })
      .from(zohoInvoices)
      .where(where);

    return NextResponse.json({
      success: true,
      data: rows,
      summary: {
        count: aggregate?.count ?? 0,
        total: Number(aggregate?.total_sum ?? 0),
        balance: Number(aggregate?.balance_sum ?? 0),
      },
      filters: { from, to, status: statusParam, customer, limit, offset },
    });
  } catch (e: any) {
    // requireAuth() redirects unauthenticated callers via Next's special
    // NEXT_REDIRECT throw — surface it so the framework handles the redirect
    // instead of returning a misleading 500.
    if (e?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
