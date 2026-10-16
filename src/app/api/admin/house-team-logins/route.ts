// ID 182 — one login per iTarang team member under the house dealer, instead
// of everyone sharing dealer@itarang.com.
//
//   GET   → every login under the house dealer code (the shared one included).
//   POST  { name, email, phone? } → create the Supabase Auth user + a users row
//         with role 'dealer' and dealer_id = the house code. Answers the
//         temporary password ONCE (shown on the Admin screen; the person must
//         change it on first sign-in). Nothing is emailed.
//   PATCH { userId, active } → switch a team login off / on (never the shared
//         house login, which resolveHouseDealer keys on).
//
// "House login" means ANY login whose users.dealer_id is the house code
// (isHouseLogin in lib/leads/pushToDealer): Step 1 "Dealer mobile", the bulk
// push and the house lead list all compare the dealer code, and every push /
// act-for-dealer record keeps the person's own users.id and name.
//
// Admin and Sales Head (Sales Head added 16 Oct at the user's request). NOTE: Supabase Auth is ONE pool shared by sandbox and
// production, so a login created here exists in both; the users row is only
// written to the database this server talks to (create it on the other DB too
// when the person needs both).

import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { generateTemporaryPassword } from "@/lib/auth/generateTemporaryPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveHouseDealer } from "@/lib/whatsapp/customer-lead";

export const dynamic = "force-dynamic";

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
});

const patchSchema = z.object({ userId: z.string().uuid(), active: z.boolean() });

/** Who manages the house team logins: Admin and Sales Head (ID 182, 16 Oct). */
const HOUSE_TEAM_LOGIN_ROLES = ["admin", "sales_head"];

async function house() {
  const h = await resolveHouseDealer();
  return h ? { code: h.dealerCode, sharedUserId: h.uploaderId } : null;
}

export const GET = withErrorHandler(async () => {
  await requireRole(HOUSE_TEAM_LOGIN_ROLES);
  const h = await house();
  if (!h) return errorResponse("The iTarang house dealer is not set up on this environment.", 500);
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      isActive: users.is_active,
      createdAt: users.created_at,
      mustChangePassword: users.must_change_password,
    })
    .from(users)
    .where(and(eq(users.dealer_id, h.code), eq(users.role, "dealer")))
    .orderBy(asc(users.created_at));
  return successResponse({
    houseDealerCode: h.code,
    logins: rows.map((r) => ({ ...r, shared: r.id === h.sharedUserId })),
  });
});

export const POST = withErrorHandler(async (req: Request) => {
  const admin = await requireRole(HOUSE_TEAM_LOGIN_ROLES);
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Check the details", 400);
  const { name, email, phone } = parsed.data;
  const h = await house();
  if (!h) return errorResponse("The iTarang house dealer is not set up on this environment.", 500);

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
    user_metadata: { role: "dealer", dealer_code: h.code, house_team: true },
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
      role: "dealer",
      dealer_id: h.code,
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

  console.log(`[house-team-logins] ${admin.id} created house login ${created.user.id} (${email})`);
  return successResponse({ userId: created.user.id, email, name, temporaryPassword }, 201);
});

export const PATCH = withErrorHandler(async (req: Request) => {
  await requireRole(HOUSE_TEAM_LOGIN_ROLES);
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("Pick a login.", 400);
  const h = await house();
  if (!h) return errorResponse("The iTarang house dealer is not set up on this environment.", 500);
  if (parsed.data.userId === h.sharedUserId) {
    return errorResponse("The shared house login can't be switched off here — WhatsApp customer files are created under it.", 409);
  }
  const rows = await db
    .update(users)
    .set({ is_active: parsed.data.active, updated_at: new Date() })
    .where(and(eq(users.id, parsed.data.userId), eq(users.dealer_id, h.code), eq(users.role, "dealer")))
    .returning({ id: users.id });
  if (!rows.length) return errorResponse("That is not a house team login.", 404);
  return successResponse({ userId: parsed.data.userId, active: parsed.data.active });
});
