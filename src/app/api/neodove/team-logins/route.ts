// NeoDove → Team (26 Oct). Admin / Sales Head create and switch off the CRM
// logins that NeoDove leads are assigned to, without a developer.
//
//   GET   → every inside_sales_rep / asm login, active or not, with the
//           campaigns each one is the default CRM owner of (E-237).
//   POST  { name, email, phone?, role } → Supabase Auth user + users row.
//         Answers the temporary password ONCE (shown on screen; the person
//         must change it on first sign-in). Nothing is emailed.
//   PATCH { userId, active } → switch a login off / on. Never a row delete:
//         users is referenced from every lead, touchpoint and ledger. Switching
//         off also clears crm_owner_user_id on campaigns that default to this
//         person, so the next push does not assign leads to a dead login.
//
// Same create / rollback flow as /api/admin/house-team-logins. Supabase Auth
// is ONE pool shared by sandbox and production, so a login made here exists in
// both; the users row is written only to the database this server talks to.
//
// Roles offered: inside_sales_rep and asm — both have a status-lifting branch
// in assignLeadOwner (see NEODOVE_ASSIGNEE_ROLES). partner is a one-off role
// and is not created here.

import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { generateTemporaryPassword } from "@/lib/auth/generateTemporaryPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NEODOVE_MANAGE_ROLES } from "@/lib/neodove/roles";

export const dynamic = "force-dynamic";

const TEAM_ROLES = ["inside_sales_rep", "asm"] as const;

const createSchema = z.object({
    name: z.string().trim().min(2, "Enter the person's name").max(120),
    email: z.string().trim().toLowerCase().email("Enter a valid email"),
    phone: z
        .string()
        .trim()
        .max(20)
        .optional()
        .transform((v) => (v ? v.replace(/\D/g, "").slice(-10) : null))
        .refine((v) => v === null || /^[6-9]\d{9}$/.test(v), "Enter a 10-digit mobile, or leave it empty"),
    role: z.enum(TEAM_ROLES, { message: "Pick Inside Sales Rep or ASM" }),
});

const patchSchema = z.object({ userId: z.string().uuid(), active: z.boolean() });

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/** Campaigns defaulting to each user. Empty on a DB without E-237. */
async function ownedCampaigns(): Promise<Map<string, { id: string; name: string }[]>> {
    const out = new Map<string, { id: string; name: string }[]>();
    const rows = rowsOf<{ owner: string; id: string; name: string }>(
        await db.execute(sql`
            SELECT to_jsonb(c) ->> 'crm_owner_user_id' AS owner, c.id, c.name
              FROM neodove_campaigns c
             WHERE (to_jsonb(c) ->> 'crm_owner_user_id') IS NOT NULL`),
    );
    for (const r of rows) out.set(r.owner, [...(out.get(r.owner) ?? []), { id: r.id, name: r.name }]);
    return out;
}

export const GET = withErrorHandler(async () => {
    await requireRole(NEODOVE_MANAGE_ROLES);
    const rows = await db
        .select({
            id: users.id,
            name: users.name,
            email: users.email,
            phone: users.phone,
            role: users.role,
            isActive: users.is_active,
            createdAt: users.created_at,
            mustChangePassword: users.must_change_password,
        })
        .from(users)
        .where(inArray(users.role, [...TEAM_ROLES]))
        .orderBy(sql`${users.is_active} DESC, ${users.name} ASC`);
    const owned = await ownedCampaigns();
    return successResponse({
        logins: rows.map((r) => ({ ...r, campaigns: owned.get(String(r.id)) ?? [] })),
    });
});

export const POST = withErrorHandler(async (req: Request) => {
    const actor = await requireRole(NEODOVE_MANAGE_ROLES);
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Check the details", 400);
    const { name, email, phone, role } = parsed.data;

    const [taken] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, email))
        .limit(1);
    if (taken) return errorResponse("A login with this email already exists.", 409);

    const temporaryPassword = generateTemporaryPassword();
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { role },
        app_metadata: { role },
    });
    if (error || !created?.user) {
        const msg = error?.message ?? "unknown error";
        return errorResponse(
            /already/i.test(msg)
                ? "This email already has a sign-in (Supabase Auth). Use another email or ask a developer to link it."
                : `Could not create the sign-in: ${msg}`,
            /already/i.test(msg) ? 409 : 500,
        );
    }

    try {
        await db.insert(users).values({
            id: created.user.id,
            email,
            name,
            role,
            phone,
            avatar_url: null,
            password_hash: await hashPassword(temporaryPassword),
            must_change_password: true,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        });
    } catch (err) {
        // Do not leave an Auth user with no users row behind (the next try would
        // collide with it on "email already exists").
        await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => undefined);
        throw err;
    }

    console.log(`[neodove/team-logins] ${actor.id} created ${role} login ${created.user.id} (${email})`);
    return successResponse({ userId: created.user.id, email, name, role, temporaryPassword }, 201);
});

export const PATCH = withErrorHandler(async (req: Request) => {
    const actor = await requireRole(NEODOVE_MANAGE_ROLES);
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse("Pick a login.", 400);
    const { userId, active } = parsed.data;

    const rows = await db
        .update(users)
        .set({ is_active: active, updated_at: new Date() })
        .where(and(eq(users.id, userId), inArray(users.role, [...TEAM_ROLES])))
        .returning({ id: users.id });
    if (!rows.length) return errorResponse("That is not an Inside Sales Rep or ASM login.", 404);

    let clearedCampaigns = 0;
    if (!active) {
        const owned = (await ownedCampaigns()).get(userId) ?? [];
        if (owned.length) {
            await db.execute(sql`
                UPDATE neodove_campaigns SET crm_owner_user_id = NULL, updated_at = now()
                 WHERE id IN (${sql.join(owned.map((c) => sql`${c.id}`), sql`, `)})`);
            clearedCampaigns = owned.length;
        }
    }

    console.log(`[neodove/team-logins] ${actor.id} set ${userId} active=${active}; cleared owner on ${clearedCampaigns} campaign(s)`);
    return successResponse({ userId, active, clearedCampaigns });
});
