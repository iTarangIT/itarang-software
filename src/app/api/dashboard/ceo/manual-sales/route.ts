// /api/dashboard/ceo/manual-sales
//   GET  — list manual dealer sales for a [start, end) window (?month=YYYY-MM | ?period=mtd|fy)
//   POST — bulk-insert manual/offline dealer sales parsed from an Excel/CSV upload.
//
// E-176. Offline dealer sales that never reach Zoho. Surfaced alongside the
// Zoho-synced rows in the Sales-to-Dealer drill-down and counted in its total.

import { and, desc, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { manualDealerSales } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { resolveWindow } from "@/lib/dashboard/salesWindow";

const MUTATE_ROLES = ["ceo", "admin"];

const RowSchema = z.object({
    sale_date: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "sale_date must be YYYY-MM-DD"),
    customer_name: z.string().trim().max(300).optional().nullable(),
    product_name: z.string().trim().max(300).optional().nullable(),
    quantity: z.number().nonnegative().optional().nullable(),
    amount: z.number().nonnegative(),
    invoice_number: z.string().trim().max(120).optional().nullable(),
});

const BodySchema = z.object({
    rows: z.array(RowSchema).min(1).max(5000),
});

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole([...MUTATE_ROLES, "sales_head"]);
    const sp = new URL(req.url).searchParams;
    const { startStr, endStr } = resolveWindow(sp.get("month"), sp.get("period"));

    const conds = [gte(manualDealerSales.sale_date, startStr)];
    if (endStr) conds.push(lt(manualDealerSales.sale_date, endStr));

    const rows = await db
        .select()
        .from(manualDealerSales)
        .where(and(...conds))
        .orderBy(desc(manualDealerSales.sale_date))
        .limit(2000);

    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    return successResponse({ rows, total });
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(MUTATE_ROLES);
    const body = BodySchema.parse(await req.json());

    const values = body.rows.map((r) => ({
        sale_date: r.sale_date,
        customer_name: r.customer_name?.trim() || null,
        product_name: r.product_name?.trim() || null,
        quantity: r.quantity == null ? null : String(r.quantity),
        amount: String(r.amount),
        invoice_number: r.invoice_number?.trim() || null,
        uploaded_by: user.id,
    }));

    if (values.length === 0) return errorResponse("No rows to insert", 400);

    await db.insert(manualDealerSales).values(values);
    return successResponse({ inserted: values.length });
});
