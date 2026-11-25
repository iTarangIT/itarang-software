/**
 * 25 Nov item 8 — the dealer page's "Orders & revenue" card: the account's
 * recorded orders still waiting for their invoice, and its invoices with what
 * was on them (line items), newest first.
 *
 * Same invoice set as My dealers' revenue and the history list (matchedUnion,
 * keyed by invoiceAccountSql, void excluded; credit notes negative), so the
 * card, the header numbers and the history never disagree. Line items come
 * from invoice_line_items (E-322) and are simply absent on a database without
 * them. Fail-soft: a failed read returns empty parts, never an error page.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceAccountSql } from "@/lib/accounts/accountList";
import { listOrderClaims, type OrderClaimRow } from "@/lib/accounts/orderClaims";
import { matchedUnion, REVENUE_IS_CREDIT, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";

export type AccountInvoiceLine = { item_name: string | null; quantity: number | null; amount_excl_gst: number | null };

export type AccountInvoice = {
    invoice_id: string;
    source: string;
    invoice_number: string | null;
    invoice_date: string;
    total: number;
    is_credit: boolean;
    lines: AccountInvoiceLine[];
};

export type AccountOrders = {
    open_orders: Pick<OrderClaimRow, "id" | "order_date" | "po_number" | "note" | "claimed_by_name" | "status" | "days_since_order">[];
    invoices: AccountInvoice[];
    /** False on a database without invoice line items: the screen says "no line detail". */
    lines_available: boolean;
};

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Which line source belongs to an invoice source (a Drive invoice's lines are vyapar or drive). */
export function lineBelongsTo(invoiceSource: string, lineSource: string): boolean {
    return lineSource === invoiceSource || (invoiceSource === "drive" && (lineSource === "vyapar" || lineSource === "drive"));
}

export async function accountOrders(accountId: string, opts: { limit?: number } = {}): Promise<AccountOrders> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const out: AccountOrders = { open_orders: [], invoices: [], lines_available: false };

    try {
        const claims = await listOrderClaims({ accountId, status: "open" });
        out.open_orders = claims.map((c) => ({
            id: c.id,
            order_date: c.order_date,
            po_number: c.po_number,
            note: c.note,
            claimed_by_name: c.claimed_by_name,
            status: c.status,
            days_since_order: c.days_since_order,
        }));
    } catch (err) {
        console.warn("[accountOrders] claims", err instanceof Error ? err.message : err);
    }

    try {
        const invoices = await matchedUnion();
        const k = invoiceAccountSql();
        const rows = rowsOf<Record<string, unknown>>(
            await db.execute(sql`
                SELECT r.id::text AS invoice_id, r.source, r.invoice_number, r.invoice_date::text AS invoice_date,
                       r.total, ${REVENUE_IS_CREDIT} AS is_credit
                  FROM ${invoices} AS r
                 WHERE ${k} = ${accountId} AND ${REVENUE_NOT_VOID}
                 ORDER BY r.invoice_date DESC, r.invoice_number DESC NULLS LAST
                 LIMIT ${limit}
            `),
        );
        out.invoices = rows.map((r) => ({
            invoice_id: String(r.invoice_id),
            source: String(r.source),
            invoice_number: (r.invoice_number as string | null) ?? null,
            invoice_date: String(r.invoice_date).slice(0, 10),
            total: Number(r.total ?? 0),
            is_credit: r.is_credit === true,
            lines: [],
        }));
    } catch (err) {
        console.warn("[accountOrders] invoices", err instanceof Error ? err.message : err);
    }

    if (out.invoices.length > 0 && (await hasInvoiceLedgerTables().catch(() => false))) {
        out.lines_available = true;
        try {
            const ids = [...new Set(out.invoices.map((i) => i.invoice_id))];
            const lines = rowsOf<Record<string, unknown>>(
                await db.execute(sql`
                    SELECT l.invoice_id, l.source, l.line_no, l.item_name, l.quantity, l.amount_excl_gst
                      FROM invoice_line_items l
                     WHERE l.invoice_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
                     ORDER BY l.invoice_id, l.line_no
                `),
            );
            for (const inv of out.invoices) {
                inv.lines = lines
                    .filter((l) => String(l.invoice_id) === inv.invoice_id && lineBelongsTo(inv.source, String(l.source)))
                    .map((l) => ({
                        item_name: (l.item_name as string | null) ?? null,
                        quantity: num(l.quantity),
                        amount_excl_gst: num(l.amount_excl_gst),
                    }));
            }
        } catch (err) {
            out.lines_available = false;
            console.warn("[accountOrders] lines", err instanceof Error ? err.message : err);
        }
    }
    return out;
}
