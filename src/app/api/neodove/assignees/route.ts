// GET /api/neodove/assignees — the CRM users a pushed lead may be assigned to
// (E-237), for the push modal's picker and the campaign form's default.
//
// WHY THIS EXISTS RATHER THAN REUSING /api/admin/users. That route is gated
// READ_ROLES = [admin, sales_head, ceo], but NEODOVE_ADMIN_ROLES also contains
// business_head and sales_manager. Both can push leads, so both open the modal
// — and would have hit a 403 that renders as an empty dropdown with no
// explanation. Widening READ_ROLES was the alternative and is worse: it hands
// the full user directory, email addresses included, to two more roles for the
// sake of a UI convenience on one screen.
//
// So this returns strictly less: id, name and role for the assignable roles
// only, no email. It also sidesteps the React-Query cache-poisoning trap
// documented in src/lib/leads/access.ts — a different endpoint cannot collide
// with the bare ["admin-user-options"] key that several pages share.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { NEODOVE_ADMIN_ROLES, NEODOVE_ASSIGNEE_ROLES } from "@/lib/neodove/roles";

export const dynamic = "force-dynamic";

export type NeodoveAssignee = {
    user_id: string;
    name: string | null;
    role: string | null;
};

export const GET = withErrorHandler(async () => {
    await requireRole(NEODOVE_ADMIN_ROLES);

    // LOWER() because seeded roles are inconsistently cased — the same reason
    // every other role comparison in this codebase does it.
    const rows = await db.execute<NeodoveAssignee>(sql`
        SELECT u.id::text AS user_id, u.name, u.role
        FROM users u
        WHERE LOWER(u.role) IN (${sql.join(
            NEODOVE_ASSIGNEE_ROLES.map((r) => sql`${r}`),
            sql`, `,
        )})
          AND u.is_active = TRUE
        ORDER BY u.name ASC NULLS LAST
    `);

    return successResponse({ assignees: rows as unknown as NeodoveAssignee[] });
});
