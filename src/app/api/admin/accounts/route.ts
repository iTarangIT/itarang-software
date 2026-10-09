/**
 * GET /api/admin/accounts — the Accounts tab (tracker P1-1 / P1-2).
 *
 * Every dealer account with its current owner, who onboarded it, whether it
 * came through a lead or a direct onboarding, and a "GSTIN missing" flag.
 * Unowned rows carry a SUGGESTED owner (suggestedOwners) — a hint only; a
 * person assigns it from the page.
 *
 * Query: q, owner=<uuid>|none, gstin_missing=1, came_through=lead|direct,
 *        status, limit (≤ 500, default 100), offset.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { suggestedOwners } from "@/lib/accounts/ownership";
import { ACCOUNT_ADMIN_ROLES, gstinMissingSql, requireAccountTables } from "./_lib";
import { dealerAccountSql } from "@/lib/accounts/accountList";
import { closedColumns } from "@/lib/accounts/accountClosures";

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
    filtered_total: number;
};

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();

    const params = Object.fromEntries(
        [...new URL(req.url).searchParams.entries()].filter(([, v]) => v !== ""),
    );
    const f = QuerySchema.parse(params);

    // Dealer accounts only: a scrap-vendor entity (users.vendor_entity_id)
    // with no dealer onboarding behind it is not a dealer account.
    const closed = await closedColumns(sql`a.id`);
    const base = sql`
        SELECT a.id,
               a.business_entity_name                     AS name,
               a.gstin,
               ${gstinMissingSql(sql`a.gstin`)}           AS gstin_missing,
               a.city, a.state, a.status, a.created_at,
               ${closed},
               o.owner_user_id::text                      AS owner_user_id,
               ou.name                                    AS owner_name,
               o.onboarded_by_user_id::text               AS onboarded_by_user_id,
               ob.name                                    AS onboarded_by_name,
               o.came_through,
               o.source_dealer_lead_id,
               COALESCE(o.source_application_id,
                        (SELECT app.id::text FROM dealer_onboarding_applications app
                          WHERE app.dealer_code = a.id
                          ORDER BY app.created_at ASC LIMIT 1)) AS source_application_id
          FROM accounts a
          LEFT JOIN account_ownership o ON o.account_id = a.id
          LEFT JOIN users ou ON ou.id = o.owner_user_id
          LEFT JOIN users ob ON ob.id = o.onboarded_by_user_id
         WHERE ${dealerAccountSql()}`;

    const where: SQL[] = [];
    if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        where.push(sql`(b.name ILIKE ${like} OR b.id ILIKE ${like} OR b.gstin ILIKE ${like}
                        OR b.city ILIKE ${like} OR b.owner_name ILIKE ${like})`);
    }
    if (f.owner === "none") where.push(sql`b.owner_user_id IS NULL`);
    else if (f.owner) where.push(sql`b.owner_user_id = ${f.owner}`);
    if (f.gstin_missing) where.push(sql`b.gstin_missing`);
    if (f.came_through === "unknown") where.push(sql`b.came_through IS NULL`);
    else if (f.came_through) where.push(sql`b.came_through = ${f.came_through}`);
    // ID 5 — "closed" is a closure (E-332), not an accounts.status value.
    if (f.status === "closed") where.push(sql`b.closed`);
    else if (f.status) where.push(sql`b.status = ${f.status} AND NOT b.closed`);
    const whereSql = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;

    const [rowsRes, countsRes] = await Promise.all([
        db.execute(sql`
            WITH b AS (${base})
            SELECT b.*, count(*) OVER () AS filtered_total
              FROM b
              ${whereSql}
             ORDER BY (b.owner_user_id IS NULL) DESC, b.created_at DESC, b.id
             LIMIT ${f.limit} OFFSET ${f.offset}
        `),
        db.execute(sql`
            WITH b AS (${base})
            SELECT count(*)                                          AS total,
                   count(*) FILTER (WHERE b.owner_user_id IS NULL)   AS no_owner,
                   count(*) FILTER (WHERE b.gstin_missing)           AS gstin_missing
              FROM b
        `),
    ]);
    const rows = rowsRes as unknown as Row[];
    const c = (countsRes as unknown as Array<Record<string, unknown>>)[0] ?? {};

    const unowned = rows.filter((r) => !r.owner_user_id).map((r) => r.id);
    const suggestions = await suggestedOwners(unowned);

    return successResponse({
        rows: rows.map((full) => {
            const r: Omit<Row, "filtered_total"> & { filtered_total?: number } = { ...full };
            delete r.filtered_total;
            return {
                ...r,
                gstin_missing: Boolean(r.gstin_missing),
                created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
                suggested_owner: r.owner_user_id ? null : (suggestions.get(r.id) ?? null),
            };
        }),
        filtered_total: Number(rows[0]?.filtered_total ?? 0),
        counts: {
            total: Number(c.total ?? 0),
            no_owner: Number(c.no_owner ?? 0),
            gstin_missing: Number(c.gstin_missing ?? 0),
        },
        limit: f.limit,
        offset: f.offset,
    });
});
