// GET /api/admin/users?roles=inside_sales_rep,asm — active-user options for the
// admin filter bar and the reassign / bulk-action target pickers.

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import type { UserOption } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "sales_head", "ceo"];
const DEFAULT_ROLES = ["inside_sales_rep", "asm"];

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const rolesParam = url.searchParams.get("roles");
    const roles = rolesParam
        ? rolesParam
              .split(",")
              .map((r) => r.trim().toLowerCase())
              .filter(Boolean)
        : DEFAULT_ROLES;

    const rows = await db.execute<UserOption>(sql`
        SELECT u.id::text AS user_id, u.name, u.email, u.role
        FROM users u
        WHERE LOWER(u.role) IN (${sql.join(
            roles.map((r) => sql`${r}`),
            sql`, `,
        )})
          AND u.is_active = TRUE
        ORDER BY u.name ASC
    `);

    return successResponse({ users: rows as unknown as UserOption[] });
});
