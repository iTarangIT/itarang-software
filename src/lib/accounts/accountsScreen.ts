/**
 * The SQL behind the Accounts screen (/admin/accounts, tracker P1-1 / P1-2),
 * split into the three requests the page makes:
 *   * accountsPageSql   — one page of rows (GET /api/admin/accounts)
 *   * accountsTotalSql  — how many rows match the filters (same request)
 *   * accountsTabCountsSql — the Live / No owner / GSTIN missing / Closed
 *                            numbers (GET /api/admin/accounts/counts), which
 *                            never depend on the filters
 * The suggested owner is its own request (GET /api/admin/accounts/suggestions)
 * so the table is not held back by it.
 *
 * Filters are applied to the base columns (a.*, o.*, ou.*), not to a CTE's
 * output, so the trigram indexes on accounts (E-192) can serve a search, and
 * there is no count(*) OVER () forcing every matching row to be built before
 * LIMIT. scripts/verify-accounts-list-perf.ts times these builders.
 */
import { sql, type SQL } from "drizzle-orm";

import { dealerAccountSql, gstinMissingSql } from "./accountList";
import { closedColumns, notClosedSql } from "./accountClosures";

export interface AccountsScreenFilters {
    q?: string;
    owner?: "none" | string;
    gstin_missing?: boolean;
    came_through?: "lead" | "direct" | "unknown";
    status?: string;
}

const FROM = sql`
      FROM accounts a
      LEFT JOIN account_ownership o ON o.account_id = a.id
      LEFT JOIN users ou ON ou.id = o.owner_user_id`;

async function whereSql(f: AccountsScreenFilters): Promise<SQL> {
    // Dealer accounts only: a scrap-vendor entity (users.vendor_entity_id)
    // with no dealer onboarding behind it is not a dealer account.
    const where: SQL[] = [dealerAccountSql()];
    if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        where.push(sql`(a.business_entity_name ILIKE ${like} OR a.id ILIKE ${like} OR a.gstin ILIKE ${like}
                        OR a.city ILIKE ${like} OR ou.name ILIKE ${like})`);
    }
    if (f.owner === "none") where.push(sql`o.owner_user_id IS NULL`);
    else if (f.owner) where.push(sql`o.owner_user_id = ${f.owner}::uuid`);
    if (f.gstin_missing) where.push(gstinMissingSql(sql`a.gstin`));
    if (f.came_through === "unknown") where.push(sql`o.came_through IS NULL`);
    else if (f.came_through) where.push(sql`o.came_through = ${f.came_through}`);
    // ID 5 — "closed" is a closure (E-332), not an accounts.status value.
    const live = await notClosedSql(sql`a.id`);
    if (f.status === "closed") where.push(sql`NOT (${live})`);
    else {
        // ID 148: every other tab lists live (not closed) dealers.
        where.push(live);
        if (f.status) where.push(sql`a.status = ${f.status}`);
    }
    return sql`WHERE ${sql.join(where, sql` AND `)}`;
}

/** One page of rows, unowned first, then newest. */
export async function accountsPageSql(f: AccountsScreenFilters, limit: number, offset: number): Promise<SQL> {
    const closed = await closedColumns(sql`a.id`);
    return sql`
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
          ${FROM}
          LEFT JOIN users ob ON ob.id = o.onboarded_by_user_id
          ${await whereSql(f)}
         ORDER BY (o.owner_user_id IS NULL) DESC, a.created_at DESC, a.id
         LIMIT ${limit} OFFSET ${offset}`;
}

/** How many rows match the filters (for the pager). */
export async function accountsTotalSql(f: AccountsScreenFilters): Promise<SQL> {
    return sql`SELECT count(*)::int AS n ${FROM} ${await whereSql(f)}`;
}

/** The four tab numbers. Independent of every filter. */
export async function accountsTabCountsSql(): Promise<SQL> {
    const live = await notClosedSql(sql`a.id`);
    return sql`
        WITH b AS (
            SELECT ${live} AS live,
                   o.owner_user_id IS NULL AS unowned,
                   ${gstinMissingSql(sql`a.gstin`)} AS gstin_missing
              FROM accounts a
              LEFT JOIN account_ownership o ON o.account_id = a.id
             WHERE ${dealerAccountSql()}
        )
        SELECT count(*) FILTER (WHERE live)                    AS total,
               count(*) FILTER (WHERE live AND unowned)        AS no_owner,
               count(*) FILTER (WHERE live AND gstin_missing)  AS gstin_missing,
               count(*) FILTER (WHERE NOT live)                AS closed
          FROM b`;
}
