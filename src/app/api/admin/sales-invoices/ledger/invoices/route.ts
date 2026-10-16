/**
 * ID 71 — the invoices finance can void or restore, for the Invoice Ledger's
 * Invoices tab (finance, CEO and Admin; the CEO's Sales invoices page was the
 * only place with the Void button, and finance could not open it).
 *
 * GET ?month=YYYY-MM&q=<number or customer>&kind=credit
 *     kind=credit lists only credit notes (ID 71: "list credit notes on the
 *     Invoices tab so they can be voided"). The month is no longer cut at
 *     300 silently: up to 2,000 rows, with the true total and whether more
 *     exist. Also returns the last credit-note fill-in run (invoice_imports).
 *     Zoho and Drive / Vyapar invoices and credit notes in the month, newest
 *     first, each with its void (reason, when) when it has one and whether
 *     its item lines are stored (a credit note nets batteries sold, By SKU and
 *     gross margin only through its lines). Voiding itself goes through
 *     POST /api/dashboard/ceo/invoices/[id]/void, which already admits these
 *     roles and keeps the one audit trail (src/lib/sales/invoiceVoids.ts).
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { matchedUnion } from "@/lib/dashboard/revenueSource";
import { requireLedger } from "../_auth";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-\d{2}$/;
const LIMIT = 2000;

export const GET = withErrorHandler(async (req: Request) => {
    await requireLedger();
    const sp = new URL(req.url).searchParams;
    const ist = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const month = MONTH.test(sp.get("month") ?? "") ? sp.get("month")! : ist;
    const q = sp.get("q")?.trim() || null;
    const creditOnly = sp.get("kind") === "credit";

    const invoices = await matchedUnion();
    const rows = await db.execute(sql`
        SELECT r.source, r.id, r.invoice_number, r.invoice_date, r.customer_name,
               r.total::float8 AS total, r.status,
               v.reason AS void_reason, v.voided_at,
               EXISTS (SELECT 1 FROM invoice_line_items l
                        WHERE l.invoice_id = r.id
                          AND (l.source = r.source OR (r.source = 'drive' AND l.source IN ('vyapar', 'drive')))) AS has_lines
          FROM ${invoices} AS r
          LEFT JOIN invoice_voids v ON v.invoice_id = r.id AND v.source = r.source
         WHERE r.source IN ${creditOnly ? sql`('credit')` : sql`('zoho', 'drive', 'credit')`}
           AND r.invoice_date >= ${`${month}-01`}::date
           AND r.invoice_date < (${`${month}-01`}::date + interval '1 month')
           AND (${q}::text IS NULL
                OR r.invoice_number ILIKE '%' || ${q} || '%'
                OR r.customer_name ILIKE '%' || ${q} || '%')
         ORDER BY r.invoice_date DESC, r.invoice_number DESC
         LIMIT ${LIMIT + 1}
    `);
    const list = rows as unknown as unknown[];
    // ID 71: when the credit-note item lines were last filled in (or never).
    const lastFill = (await db
        .execute(sql`
            SELECT created_at, summary FROM invoice_imports
             WHERE kind = 'credit_lines_fill' ORDER BY created_at DESC LIMIT 1`)
        .catch(() => [])) as unknown as Array<{ created_at: string; summary: Record<string, unknown> | null }>;
    return successResponse({
        month,
        rows: list.slice(0, LIMIT),
        limit: LIMIT,
        more: list.length > LIMIT,
        credit_fill: lastFill[0] ? { at: lastFill[0].created_at, summary: lastFill[0].summary } : null,
    });
});
