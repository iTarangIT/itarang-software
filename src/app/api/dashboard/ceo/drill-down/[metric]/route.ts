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
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions, inventory, manualDealerSales, users, zohoInvoices } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
  approvedExpenseInWindow,
  expenseEffectiveDate,
  resolveWindow,
} from "@/lib/dashboard/salesWindow";
import { fetchInvoiceLineItems } from "@/lib/zoho/invoices";
import { UNCLASSIFIED_BUCKET_KEY, isExpenseBucket } from "@/lib/expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "sales_head"]);
const METRICS = new Set(["purchases", "sales", "expenses", "inventory", "outstanding"]);
const ROW_CAP = 500;
// Live Zoho line-item enrichment is N detail calls (one per invoice), so bound
// it: only the most recent DETAIL_CAP invoices in the window are expanded into
// per-product rows; older ones fall back to a single invoice-level row.
const DETAIL_CAP = 120;
const DETAIL_CONCURRENCY = 5;

// Run async tasks in fixed-size batches to avoid hammering the Zoho API.
async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

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

    // Resolve the [start, end) window as local date strings. Shared with the
    // Expenses card and the bucket panel — a private copy here is how a
    // drill-down starts disagreeing with the number that opened it.
    const { startStr, endStr } = resolveWindow(
      sp.get("month"),
      sp.get("period"),
      sp.get("year"),
    );

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
        sql`(${zohoInvoices.status} IS NULL OR ${zohoInvoices.status} NOT IN ('void'))`,
      ];
      if (endStr) conds.push(lt(zohoInvoices.invoice_date, endStr));
      const invoiceRows = await db
        .select({
          zoho_invoice_id: zohoInvoices.zoho_invoice_id,
          organization_id: zohoInvoices.organization_id,
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
      // Total reconciles with the card: sum of INVOICE totals (not line items).
      total = invoiceRows.reduce((s, r) => s + Number(r.total || 0), 0);

      // Enrich the most recent invoices with line items (quantity + product
      // name) via live Zoho detail calls, then expand to one row per product.
      const toEnrich = invoiceRows.slice(0, DETAIL_CAP);
      const lineItemsByInvoice = new Map<string, Awaited<ReturnType<typeof fetchInvoiceLineItems>>>();
      await inBatches(toEnrich, DETAIL_CONCURRENCY, async (inv) => {
        try {
          const items = await fetchInvoiceLineItems(
            inv.zoho_invoice_id,
            inv.organization_id ?? undefined,
          );
          lineItemsByInvoice.set(inv.zoho_invoice_id, items);
        } catch {
          // Degrade gracefully — invoice still shows as a single row below.
          lineItemsByInvoice.set(inv.zoho_invoice_id, []);
        }
        return null;
      });

      rows = invoiceRows.flatMap((inv) => {
        const base = {
          zoho_invoice_id: inv.zoho_invoice_id,
          invoice_number: inv.invoice_number,
          customer_name: inv.customer_name,
          invoice_date: inv.invoice_date,
          total: inv.total,
          status: inv.status,
        };
        const items = lineItemsByInvoice.get(inv.zoho_invoice_id);
        if (!items || items.length === 0) {
          return [{ ...base, _first: true, product_name: null, quantity: null }];
        }
        return items.map((li, idx) => ({
          ...base,
          _first: idx === 0,
          product_name: li.name ?? null,
          quantity: li.quantity ?? null,
        }));
      });

      // Merge manual / offline dealer sales (E-176) for the same window — they
      // show alongside the Zoho rows and count toward the total. Guarded: if the
      // table hasn't been migrated yet, skip rather than failing the drill-down.
      try {
        const manualConds = [gte(manualDealerSales.sale_date, startStr)];
        if (endStr) manualConds.push(lt(manualDealerSales.sale_date, endStr));
        const manualRows = await db
          .select()
          .from(manualDealerSales)
          .where(and(...manualConds))
          .orderBy(desc(manualDealerSales.sale_date))
          .limit(ROW_CAP);
        const manualMapped = manualRows.map((m) => ({
          _first: true,
          zoho_invoice_id: null,
          invoice_number: m.invoice_number,
          customer_name: m.customer_name,
          invoice_date: m.sale_date,
          product_name: m.product_name,
          quantity: m.quantity,
          total: m.amount,
          status: "offline",
        }));
        rows = [...manualMapped, ...rows];
        total += manualRows.reduce((s, m) => s + Number(m.amount || 0), 0);
      } catch (e) {
        // 42P01 undefined_table → migration not applied yet; ignore manual sales.
        console.warn("[drill-down/sales] manual_dealer_sales unavailable:", errorMessage(e));
      }
    } else if (metric === "expenses") {
      // E-216 — must match the Expenses card exactly: windowed on
      // COALESCE(expense_date, approved_at::date), not approved_at. If these
      // two drift, clicking the card opens a list whose rows do not add up to
      // the number that was clicked.
      //
      // E-218 — ?bucket= narrows to one tile of the bucket panel. "unclassified"
      // is the synthetic key for rows the backfill has not reached, so it maps
      // to IS NULL rather than to a stored value.
      const bucketParam = sp.get("bucket");
      const bucketFilter =
        bucketParam === UNCLASSIFIED_BUCKET_KEY
          ? isNull(expenseSubmissions.bucket)
          : isExpenseBucket(bucketParam)
            ? eq(expenseSubmissions.bucket, bucketParam)
            : undefined;

      rows = await db
        .select({
          invoice_number: expenseSubmissions.invoice_number,
          vendor: expenseSubmissions.vendor,
          department: expenseSubmissions.department,
          bucket: expenseSubmissions.bucket,
          project_tag: expenseSubmissions.project_tag,
          amount: expenseSubmissions.amount,
          expense_date: expenseSubmissions.expense_date,
          created_at: expenseSubmissions.created_at,
          bill_url: expenseSubmissions.bill_url,
          submitter_name: users.name,
        })
        .from(expenseSubmissions)
        .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
        .where(and(approvedExpenseInWindow(startStr, endStr), bucketFilter))
        .orderBy(desc(expenseEffectiveDate()))
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
          due_date: zohoInvoices.due_date,
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
