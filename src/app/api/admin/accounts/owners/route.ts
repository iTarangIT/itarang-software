/**
 * GET /api/admin/accounts/owners — users for the Accounts tab dropdowns.
 *
 * `assignable`: active users with a sales role (who an account can be
 * given to). `current`: everyone who owns at least one account right now,
 * active or not — the "from" list of the leaver move, with their counts.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_ADMIN_ROLES, ASSIGNABLE_OWNER_ROLES, requireAccountTables } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();

    const [assignable, current] = await Promise.all([
        db.execute(sql`
            SELECT id::text AS id, name, lower(role) AS role
              FROM users
             WHERE is_active IS NOT FALSE
               AND lower(role) IN (${sql.join(ASSIGNABLE_OWNER_ROLES.map((r) => sql`${r}`), sql`, `)})
             ORDER BY name
        `),
        db.execute(sql`
            SELECT u.id::text AS id, u.name, lower(u.role) AS role,
                   (u.is_active IS NOT FALSE) AS is_active,
                   count(*)::int AS account_count
              FROM account_ownership o
              JOIN users u ON u.id = o.owner_user_id
             GROUP BY u.id, u.name, u.role, u.is_active
             ORDER BY u.name
        `),
    ]);

    return successResponse({ assignable, current });
});
