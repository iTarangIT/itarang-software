/**
 * GET /api/dashboard/ceo/account-quotations — E-356: the CEO's queue of
 * ACCOUNT quotations. `?status=pending` (default) is the approval queue,
 * oldest first; `?status=history` is what was approved or rejected, newest
 * first. Each row carries the Account ID and name and why it is waiting (the
 * OEM per-line verdict and any credit-terms hold), the same evidence the lead
 * queue gives.
 */
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { linesNeedingAttention, type OemEvaluation } from "@/lib/leads/oemPricing";
import { hasAccountQuotationTables } from "@/lib/accounts/quotations/access";

export const dynamic = "force-dynamic";

const CAP = 100;

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(["ceo", "admin"]);
    const history = req.nextUrl.searchParams.get("status") === "history";
    if (!(await hasAccountQuotationTables())) {
        return successResponse({ status: history ? "history" : "pending", total: 0, quotations: [], set_up: false });
    }
    const where = history
        ? sql`q.approval_status IN ('approved', 'rejected') AND q.approval_mode = 'manual'`
        : sql`q.approval_status = 'pending' AND q.withdrawn_at IS NULL`;
    const rows = (await db.execute(sql`
        SELECT q.quotation_id::text AS quotation_id, q.account_id, a.business_entity_name AS account_name,
               a.city, q.version_no, q.price_quoted::text AS price_quoted, q.product_lines, q.oem_evaluation,
               q.credit_terms, q.delivery_terms, q.warranty_terms, q.notes,
               q.approval_status, q.rejection_reason, q.quote_number,
               q.approved_at::text AS approved_at, ap.name AS approved_by_name,
               q.created_at::text AS created_at, cu.name AS raised_by, ou.name AS owner_name
          FROM account_quotations q
          LEFT JOIN accounts a ON a.id = q.account_id
          LEFT JOIN account_ownership ao ON ao.account_id = q.account_id
          LEFT JOIN users ou ON ou.id = ao.owner_user_id
          LEFT JOIN users cu ON cu.id = q.created_by
          LEFT JOIN users ap ON ap.id = q.approved_by
         WHERE ${where}
         ORDER BY ${history ? sql`q.approved_at DESC NULLS LAST` : sql`q.created_at ASC`}
         LIMIT ${CAP}
    `)) as unknown as Array<Record<string, unknown> & { oem_evaluation: OemEvaluation | null; product_lines: unknown }>;
    const totals = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM account_quotations q WHERE ${where}
    `)) as unknown as Array<{ n: number }>;

    return successResponse({
        status: history ? "history" : "pending",
        total: Number(totals[0]?.n ?? 0),
        set_up: true,
        quotations: rows.map(({ oem_evaluation: e, product_lines, ...r }) => ({
            ...r,
            value: Number(r.price_quoted ?? 0),
            line_count: Array.isArray(product_lines) ? product_lines.length : 0,
            oem:
                e && Array.isArray(e.lines)
                    ? {
                          reason: e.reason,
                          shortfall_total: Number(e.shortfall_total ?? 0),
                          lines_flagged: linesNeedingAttention(e),
                          terms_hold: e.terms_hold ?? null,
                          lines: e.lines.map((l) => ({
                              product_name: l.product_name,
                              quantity: l.quantity,
                              quoted_unit_price: l.quoted_unit_price,
                              oem_price: l.oem_price,
                              delta: l.delta,
                              status: l.status,
                          })),
                      }
                    : null,
        })),
    });
});
