/**
 * GET /api/admin/accounts — the Accounts tab (tracker P1-1 / P1-2).
 *
 * Every dealer account with its current owner, who onboarded it, whether it
 * came through a lead or a direct onboarding, and a "GSTIN missing" flag.
 * Unowned rows carry a SUGGESTED owner — a hint only; a person assigns it
 * from the page. For speed it is NOT computed here: the page fetches it from
 * ./suggestions once the rows are on screen, and the tab numbers from
 * ./counts (they never depend on the filters). SQL: lib/accounts/accountsScreen.
 *
 * Query: q, owner=<uuid>|none, gstin_missing=1, came_through=lead|direct,
 *        status, limit (≤ 500, default 100), offset.
 */
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_ADMIN_ROLES, requireAccountTables } from "./_lib";
import { accountsPageSql, accountsTotalSql } from "@/lib/accounts/accountsScreen";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
    q: z.string().trim().max(200).optional(),
    owner: z.union([z.literal("none"), z.string().uuid()]).optional(),
    gstin_missing: z.enum(["1", "true"]).optional(),
    came_through: z.enum(["lead", "direct", "unknown"]).optional(),
    status: z.string().trim().max(30).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
});

type Row = {
    id: string;
    name: string;
    gstin: string | null;
    gstin_missing: boolean;
    city: string | null;
    state: string | null;
    status: string;
    created_at: string;
    owner_user_id: string | null;
    owner_name: string | null;
    onboarded_by_user_id: string | null;
    onboarded_by_name: string | null;
    came_through: string | null;
    source_dealer_lead_id: string | null;
    source_application_id: string | null;
    /** ID 5 — closed by hand (E-332), with the reason. */
    closed: boolean;
    closed_reason: string | null;
};

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();

    const params = Object.fromEntries(
        [...new URL(req.url).searchParams.entries()].filter(([, v]) => v !== ""),
    );
    const f = QuerySchema.parse(params);
    const filters = {
        q: f.q,
        owner: f.owner,
        gstin_missing: Boolean(f.gstin_missing),
        came_through: f.came_through,
        status: f.status,
    };

    const [rowsRes, totalRes] = await Promise.all([
        accountsPageSql(filters, f.limit, f.offset).then((q) => db.execute(q)),
        accountsTotalSql(filters).then((q) => db.execute(q)),
    ]);
    const rows = rowsRes as unknown as Row[];
    const total = (totalRes as unknown as Array<{ n: number | string }>)[0]?.n ?? 0;

    return successResponse({
        rows: rows.map((r) => ({
            ...r,
            gstin_missing: Boolean(r.gstin_missing),
            created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        })),
        filtered_total: Number(total),
        limit: f.limit,
        offset: f.offset,
    });
});
