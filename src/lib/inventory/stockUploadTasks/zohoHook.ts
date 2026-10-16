/**
 * Tracker ID 174 — "Stock to upload" tasks for Zoho invoices.
 *
 * Zoho invoices reach the CRM two ways, and neither carries lines in the
 * hourly sync: src/lib/zoho/sync.ts copies the invoice LIST (no lines), and
 * scripts/backfill-zoho-gstin-lines.ts reads each invoice's detail into
 * invoice_line_items. So:
 *   - the backfill hands the lines it just read (rules.ts zohoLinesForSerials) →
 *     recordInvoiceSerials(…, { source: "zoho" });
 *   - the sync calls recordNewZohoInvoice() for an invoice it has just
 *     INSERTED: when it is dated from the day tasks went live, one detail call
 *     reads its lines and opens the task. Older invoices make no call.
 * Both are best-effort and never throw: a Zoho failure must not stop a sync.
 */
import type { ZohoInvoiceLineItem } from "@/lib/zoho/invoices";
import { importedInvoiceOpensTask, zohoLinesForSerials } from "@/lib/inventory/stockUploadTasks/rules";
import { hasStockTaskTables, recordInvoiceSerials } from "@/lib/inventory/stockUploadTasks/service";

/** Open the task for Zoho invoice `zohoRowId` (zoho_invoices.id) from lines already read. Never throws. */
export async function recordZohoInvoiceSerials(zohoRowId: string, lines: readonly ZohoInvoiceLineItem[]): Promise<number | null> {
    return recordInvoiceSerials(zohoRowId, zohoLinesForSerials(lines), { source: "zoho", origin: "zoho" });
}

/**
 * The hourly sync just inserted this invoice. Dated before tasks went live (or
 * without E-348): nothing, no Zoho call. Otherwise read its lines (one detail
 * call) and open the task. Never throws.
 */
export async function recordNewZohoInvoice(input: {
    zohoRowId: string;
    zohoInvoiceId: string;
    organizationId: string | null;
    invoiceDate: string | null;
}): Promise<void> {
    try {
        if (!input.invoiceDate || !importedInvoiceOpensTask(input.invoiceDate)) return;
        if (!(await hasStockTaskTables())) return;
        const { fetchInvoiceDetail } = await import("@/lib/zoho/invoices");
        const detail = await fetchInvoiceDetail(input.zohoInvoiceId, input.organizationId ?? undefined);
        await recordZohoInvoiceSerials(input.zohoRowId, detail.line_items);
    } catch (e) {
        console.warn("[stock-tasks] Zoho invoice lines not read:", e instanceof Error ? e.message : e);
    }
}
