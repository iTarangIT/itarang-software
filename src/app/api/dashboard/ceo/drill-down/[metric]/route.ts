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
import { expenseSubmissions, inventory, manualDealerSales, users } from "@/lib/db/schema";
// E-280 — the sales and outstanding drill-downs read both revenue sources.
import { drillDownRows } from "@/lib/dashboard/revenueSource";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
  approvedExpenseInWindow,
  expenseEffectiveDate,
  resolveWindowParams,
} from "@/lib/dashboard/salesWindow";
import { fetchInvoiceLineItems } from "@/lib/zoho/invoices";
import {
  EXPENSE_DEPARTMENT_VALUES,
  UNASSIGNED_DEPARTMENT_KEY,
  UNCLASSIFIED_BUCKET_KEY,
  isExpenseBucket,
} from "@/lib/expenses";

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
    //
    // E-219 — via resolveWindowParams rather than resolveWindow, so the CEO
    // filter bar's ?from=/&to= range reaches this list too. Opening a drill-down
    // from a card filtered to a custom range used to silently answer with the
    // current month: the same window has to mean the same days everywhere.
    const resolved = resolveWindowParams(sp);
    if (!resolved.ok) {
      return NextResponse.json(
        { success: false, error: { message: resolved.error } },
        { status: 400 },
      );
    }
    const { startStr, endStr } = resolved.window;

    let rows: Record<string, unknown>[] = [];
    let total = 0;
    // E-224 — did ROW_CAP actually bite? The client sorts the rows it was given,
    // so a truncated list re-sorted ascending would show the smallest of the
    // most recent 500 while reading as the smallest of the period. Counted on
    // the DB result, not on `rows`, because the sales branch expands one invoice
    // into several rows and its length says nothing about the cap.
    let capped = false;

    if (metric === "purchases") {
      // inventory.oem_invoice_date is a timestamptz; compare against date strings.
      // Both bounds are optional — an unbounded window (period=inception) drops
      // the predicate rather than scanning from an invented earliest date.
      const conds = [];
      if (startStr) conds.push(gte(inventory.oem_invoice_date, sql`${startStr}::date`));
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
      capped = rows.length >= ROW_CAP;
      total = rows.reduce((s, r) => s + Number(r.final_amount || 0), 0);
    } else if (metric === "sales") {
      const unioned = await drillDownRows("sales", startStr, endStr, ROW_CAP);
      // `zoho_invoice_id` survives only for Zoho rows: it is what the live
      // line-item lookup below is keyed on, and a Drive invoice has no such id
      // and no line-item detail to fetch. Deriving it from the union's
      // document_url keeps the enrichment loop unchanged rather than teaching
      // it about a second shape.
      const invoiceRows = unioned.map((r) => ({
        source: r.source,
        zoho_invoice_id:
          r.source === "zoho"
            ? (r.document_url?.match(/invoices\/([^/]+)\/pdf/)?.[1] ?? "")
            : "",
        // The drill-down's "View" link. Zoho rows resolve to the PDF
        // passthrough, Drive rows to the stored copy of the original — without
        // this, every Drive invoice showed a dash where the link should be.
        document_url: r.document_url,
        organization_id: r.organization_id,
        invoice_number: r.invoice_number,
        customer_name: r.customer_name,
        invoice_date: r.invoice_date,
        total: r.total,
        status: r.status,
      }));
      capped = invoiceRows.length >= ROW_CAP;
      // Total reconciles with the card: sum of INVOICE totals (not line items).
      total = invoiceRows.reduce((s, r) => s + Number(r.total || 0), 0);

      // Enrich the most recent invoices with line items (quantity + product
      // name) via live Zoho detail calls, then expand to one row per product.
      // Drive invoices are skipped here: they are stored as a total, not as a
      // priced line list, so there is nothing to expand and no API to ask.
      const toEnrich = invoiceRows
        .filter((inv) => inv.source === "zoho" && inv.zoho_invoice_id)
        .slice(0, DETAIL_CAP);
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

      rows = invoiceRows.flatMap((inv): Record<string, unknown>[] => {
        const base = {
          zoho_invoice_id: inv.zoho_invoice_id,
          source: inv.source,
          document_url: inv.document_url,
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
        const manualConds = [];
        if (startStr) manualConds.push(gte(manualDealerSales.sale_date, startStr));
        if (endStr) manualConds.push(lt(manualDealerSales.sale_date, endStr));
        const manualRows = await db
          .select()
          .from(manualDealerSales)
          .where(and(...manualConds))
          .orderBy(desc(manualDealerSales.sale_date))
          .limit(ROW_CAP);
        if (manualRows.length >= ROW_CAP) capped = true;
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
      // E-218 — ?bucket= narrows to one bucket. "unclassified" is the synthetic
      // key for rows the backfill has not reached, so it maps to IS NULL rather
      // than to a stored value.
      const bucketParam = sp.get("bucket");
      const bucketFilter =
        bucketParam === UNCLASSIFIED_BUCKET_KEY
          ? isNull(expenseSubmissions.bucket)
          : isExpenseBucket(bucketParam)
            ? eq(expenseSubmissions.bucket, bucketParam)
            : undefined;

      // E-219 — ?department= narrows the same list to one department, the same
      // shape and for the same reason: applied here rather than to the fetched
      // rows, because those stop at ROW_CAP and a client-side filter of a
      // truncated page shows a subset of a department while the count beside
      // the dropdown states the true one.
      //
      // An unrecognised value is ignored rather than 400'd — it can only come
      // from a stale dropdown option, and answering the unfiltered window is
      // more useful there than refusing the whole drill-down.
      const deptParam = sp.get("department");
      const deptFilter =
        deptParam === UNASSIGNED_DEPARTMENT_KEY
          ? isNull(expenseSubmissions.department)
          : deptParam && EXPENSE_DEPARTMENT_VALUES.includes(deptParam as never)
            ? eq(expenseSubmissions.department, deptParam)
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
        .where(
          and(approvedExpenseInWindow(startStr, endStr), bucketFilter, deptFilter),
        )
        .orderBy(desc(expenseEffectiveDate()))
        .limit(ROW_CAP);
      capped = rows.length >= ROW_CAP;
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
      capped = rows.length >= ROW_CAP;
      total = rows.reduce((s, r) => s + Number(r.final_amount || 0), 0);
    } else if (metric === "outstanding") {
      // All-time snapshot, as before — a receivable does not stop being owed
      // because the selected month ended.
      rows = (await drillDownRows("outstanding", null, null, ROW_CAP)).map((r) => ({
        source: r.source,
        invoice_number: r.invoice_number,
        customer_name: r.customer_name,
        invoice_date: r.invoice_date,
        due_date: r.due_date,
        document_url: r.document_url,
        total: r.total,
        balance: r.balance,
        status: r.status,
      }));
      capped = rows.length >= ROW_CAP;
      total = rows.reduce((s, r) => s + Number(r.balance || 0), 0);
    }

    return NextResponse.json({
      success: true,
      data: { metric, total, rows, capped, cap: ROW_CAP },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
