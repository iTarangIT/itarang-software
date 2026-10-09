/**
 * ID 71 — the invoices finance can void or restore, for the Invoice Ledger's
 * Invoices tab (finance, CEO and Admin; the CEO's Sales invoices page was the
 * only place with the Void button, and finance could not open it).
 *
 * GET ?month=YYYY-MM&q=<number or customer>
 *     Zoho and Drive / Vyapar invoices in the month, newest first, each with
 *     its void (reason, when) when it has one. Voiding itself goes through
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
const LIMIT = 300;

export const GET = withErrorHandler(async (req: Request) => {
    await requireLedger();
    const sp = new URL(req.url).searchParams;
    const ist = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const month = MONTH.test(sp.get("month") ?? "") ? sp.get("month")! : ist;
    const q = sp.get("q")?.trim() || null;

    const invoices = await matchedUnion();
    const rows = await db.execute(sql`
        SELECT r.source, r.id, r.invoice_number, r.invoice_date, r.customer_name,
               r.total::float8 AS total, r.status,
               v.reason AS void_reason, v.voided_at
          FROM ${invoices} AS r
          LEFT JOIN invoice_voids v
                 ON v.invoice_id = r.id AND (v.source = r.source OR (r.source = 'drive' AND v.source = 'vyapar'))
         WHERE r.source IN ('zoho', 'drive')
           AND r.invoice_date >= ${`${month}-01`}::date
           AND r.invoice_date < (${`${month}-01`}::date + interval '1 month')
           AND (${q}::text IS NULL
                OR r.invoice_number ILIKE '%' || ${q} || '%'
                OR r.customer_name ILIKE '%' || ${q} || '%')
         ORDER BY r.invoice_date DESC, r.invoice_number DESC
         LIMIT ${LIMIT}
    `);
    return successResponse({ month, rows, limit: LIMIT });
});
