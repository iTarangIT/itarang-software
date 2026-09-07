/**
 * E-280 — GET /api/dashboard/ceo/invoices
 *
 * The Sales Invoices page's list, summary and CSV export, over BOTH revenue
 * sources: the historical Zoho sync and the invoices now read out of Google
 * Drive.
 *
 * This replaces /api/admin/zoho/invoices for the page. That route is left
 * exactly as it was — it still works, still Zoho-only — because its name now
 * describes only half the truth and rewriting it in place would have made every
 * caller's expectations silently wrong. Same params, same response shape, so
 * the page swap is one URL.
 *
 * The window is INCLUSIVE on `to`, which differs from the dashboard's half-open
 * [start, end) window. That is deliberate and pre-existing: this page has always
 * taken two dates a human typed and meant both of them. Changing it here would
 * have moved the page's totals for reasons unrelated to this feature.
 */
import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
  isDriveRevenueAvailable,
  listRevenueInvoices,
  listRevenueInvoicesForExport,
  revenueSummary,
  type RevenueListFilters,
} from "@/lib/dashboard/revenueSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "finance_controller"]);
/** Kept identical to the page's filter chips. */
const KNOWN_STATUSES = new Set([
  "draft",
  "sent",
  "overdue",
  "paid",
  "partially_paid",
  "void",
]);
const CSV_ROW_CAP = 10_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function startOfMonthISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
    const from = sp.get("from") || startOfMonthISO();
    const to = sp.get("to") || todayISO();
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      return NextResponse.json(
        { success: false, error: { message: "from and to must be YYYY-MM-DD" } },
        { status: 400 },
      );
    }

    const statusParam = sp.get("status");
    const statuses = statusParam
      ? statusParam
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => KNOWN_STATUSES.has(s))
      : null;

    const sourceParam = (sp.get("source") || "").toLowerCase();
    const source =
      sourceParam === "zoho" || sourceParam === "drive" ? sourceParam : null;

    const filters: RevenueListFilters = {
      from,
      to,
      statuses: statuses && statuses.length > 0 ? statuses : null,
      customer: sp.get("customer"),
      source,
    };

    if (sp.get("format") === "csv") {
      const rows = await listRevenueInvoicesForExport(filters, CSV_ROW_CAP);
      const header = [
        "Source",
        "Invoice Number",
        "Invoice Date",
        "Customer",
        "Status",
        "Total",
        "Balance",
        "Transaction ID",
        "Needs Attention",
      ];
      const body = rows.map((r) =>
        [
          r.source,
          r.invoice_number,
          r.invoice_date,
          r.customer_name,
          r.status,
          r.total,
          r.balance,
          r.payment_reference,
          r.needs_attention ? r.attention_reason || "yes" : "",
        ]
          .map(csvCell)
          .join(","),
      );
      const csv = [header.join(","), ...body].join("\n");
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="sales-invoices-${from}-to-${to}.csv"`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    const limit = Math.min(Math.max(Number(sp.get("limit")) || 50, 1), 500);
    const offset = Math.max(Number(sp.get("offset")) || 0, 0);

    const [data, summary, driveAvailable] = await Promise.all([
      listRevenueInvoices({ ...filters, limit, offset }),
      revenueSummary(filters),
      isDriveRevenueAvailable(),
    ]);

    return NextResponse.json({
      success: true,
      data,
      summary,
      filters: { from, to, status: statusParam, customer: sp.get("customer") || "", limit, offset },
      // Lets the page say WHY there are no Drive invoices, instead of showing
      // an empty column that looks like nothing was ever imported.
      sources: { zoho: true, drive: driveAvailable },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
