// A39 — who can log in.
//
// GET  every staff login: active or not, forced reset pending, when the
//      password was last set (E-352), last download. Admin and CEO read.
// POST { user_id, action: "deactivate" | "activate" | "force_reset" } — Admin.
//      deactivate: users.is_active = false (every page and API refuses them
//      from the next request) and the Supabase login is banned, so a leaver
//      cannot sign in again. force_reset: must_change_password = true — they
//      choose a new password at their next page load. Each change is logged
//      in audit_logs.

import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo"];
const EDIT_ROLES = ["admin"];

const Body = z.object({
    user_id: z.string().min(1).max(64),
    action: z.enum(["deactivate", "activate", "force_reset"]),
});

export const GET = withErrorHandler(async () => {
    const me = await requireRole(READ_ROLES);
    const hasMeta = ((await db.execute(sql`SELECT to_regclass('public.user_password_meta') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>)[0]?.ok;
    const rows = await db.execute(sql`
        SELECT u.id::text AS id, u.name, u.email, u.role, u.is_active IS NOT FALSE AS is_active,
               COALESCE(u.must_change_password, false) AS must_change_password,
               ${hasMeta ? sql`(SELECT m.password_changed_at::text FROM user_password_meta m WHERE m.user_id = u.id::text)` : sql`NULL::text`} AS password_changed_at,
               (SELECT MAX(d.created_at)::text FROM data_download_log d WHERE d.user_id = u.id::text) AS last_download_at
          FROM users u
         WHERE lower(u.role) NOT IN ('dealer', 'nbfc_partner', 'vendor', 'refurbisher')
         ORDER BY (u.is_active IS NOT FALSE) DESC, u.name
    `).catch(() =>
        // data_download_log missing (E-312): the same list without it.
        db.execute(sql`
            SELECT u.id::text AS id, u.name, u.email, u.role, u.is_active IS NOT FALSE AS is_active,
                   COALESCE(u.must_change_password, false) AS must_change_password,
                   NULL::text AS password_changed_at, NULL::text AS last_download_at
              FROM users u
             WHERE lower(u.role) NOT IN ('dealer', 'nbfc_partner', 'vendor', 'refurbisher')
             ORDER BY (u.is_active IS NOT FALSE) DESC, u.name`),
    );
    return successResponse({ rows, can_edit: EDIT_ROLES.includes(me.role) });
});

export const POST = withErrorHandler(async (req: Request) => {
    const me = await requireRole(EDIT_ROLES);
    const b = Body.parse(await req.json());
    if (b.user_id === me.id && b.action === "deactivate") return errorResponse("You cannot deactivate your own login.", 400);

    const set =
        b.action === "deactivate"
            ? sql`is_active = false`
            : b.action === "activate"
              ? sql`is_active = true`
              : sql`must_change_password = true`;
    const res = (await db.execute(sql`
        UPDATE users SET ${set}, updated_at = now() WHERE id::text = ${b.user_id}
        RETURNING id::text AS id, name, email
    `)) as unknown as Array<{ id: string; name: string | null; email: string | null }>;
    if (!res.length) return errorResponse("No such user.", 404);

    // Ban / unban the Supabase login too, so a leaver cannot even sign in.
    let authNote: string | null = null;
    if (b.action !== "force_reset") {
        try {
            const { supabaseAdmin } = await import("@/lib/supabase/admin");
            const { error } = await supabaseAdmin.auth.admin.updateUserById(b.user_id, {
                ban_duration: b.action === "deactivate" ? "876000h" : "none",
            });
            if (error) authNote = error.message;
        } catch (e) {
            authNote = e instanceof Error ? e.message : String(e);
        }
    }

    await db
        .execute(sql`
            INSERT INTO audit_logs (id, entity_type, entity_id, action, changes, performed_by)
            VALUES (${`AUDIT-LOGIN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'user', ${b.user_id},
                    ${`login_${b.action}`}, ${JSON.stringify({ by: me.id, auth_note: authNote })}::jsonb, ${me.id}::uuid)`)
        .catch((e) => console.warn("[users/access] audit log not written:", e instanceof Error ? e.message : e));

    return successResponse({ user: res[0], action: b.action, auth_note: authNote });
});
