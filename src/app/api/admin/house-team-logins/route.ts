// ID 182 — one login per iTarang team member under the house dealer, instead
// of everyone sharing dealer@itarang.com.
//
//   GET   → every login under the house dealer code (the shared one included).
//   POST  { name, email, phone? } → create the Supabase Auth user + a users row
//         with role 'dealer' and dealer_id = the house code. Answers the
//         temporary password ONCE (shown on the Admin screen; the person must
//         change it on first sign-in). 23 Nov: the email + temporary password
//         are also emailed to the new login, with the sign-in link.
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
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { houseLoginStaffLinks, users } from "@/lib/db/schema";
import { staffOptions } from "@/lib/users/staff-options";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { generateTemporaryPassword } from "@/lib/auth/generateTemporaryPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveHouseDealer } from "@/lib/whatsapp/customer-lead";
import { getDealerCheckSettings, setHouseApprover } from "@/lib/leads/dealer-check-settings";
import { sendEmail } from "@/lib/email/mailer";

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

// `active` switches a login on/off; `staffUserId` (E-390) links the login to
// the iTarang sales person who uses it (null = unlink); `canApprove` (23 Nov)
// lets the login approve / change / reject dealer checks. Any combination.
const patchSchema = z
  .object({
    userId: z.string().uuid(),
    active: z.boolean().optional(),
    staffUserId: z.string().uuid().nullable().optional(),
    canApprove: z.boolean().optional(),
  })
  .refine((b) => b.active !== undefined || b.staffUserId !== undefined || b.canApprove !== undefined, {
    message: "Nothing to change",
  });

async function staffLinks(loginIds: string[]): Promise<Map<string, string>> {
  if (!loginIds.length) return new Map();
  try {
    const rows = await db
      .select({ login: houseLoginStaffLinks.login_user_id, staff: houseLoginStaffLinks.staff_user_id })
      .from(houseLoginStaffLinks)
      .where(inArray(houseLoginStaffLinks.login_user_id, loginIds));
    return new Map(rows.map((r) => [r.login, r.staff]));
  } catch {
    // Database without E-390: no links yet.
    return new Map();
  }
}


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
  const [links, staff, dcs] = await Promise.all([staffLinks(rows.map((r) => r.id)), staffOptions(), getDealerCheckSettings()]);
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  return successResponse({
    houseDealerCode: h.code,
    logins: rows.map((r) => ({
      ...r,
      shared: r.id === h.sharedUserId,
      // The main login always decides dealer checks; others when switched on.
      canApprove: r.id === h.sharedUserId || dcs.houseApproverIds.includes(r.id),
      staffUserId: links.get(r.id) ?? null,
      staffName: links.has(r.id) ? staffName.get(links.get(r.id)!) ?? null : null,
    })),
    staff,
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

  // 23 Nov (point 2): email the sign-in details to the new login.
  let emailed = false;
  try {
    const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.itarang.com").replace(/\/+$/, "");
    const loginUrl = `${base}/login`;
    const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    const res = await sendEmail({
      to: email,
      subject: "[iTarang] Your iTarang House login",
      text:
        `Hi ${name},

${admin.name || "iTarang"} created an iTarang House login for you.

` +
        `Sign in: ${loginUrl}
Email: ${email}
Temporary password: ${temporaryPassword}

` +
        `You will be asked to set your own password the first time you sign in. Every step you take on a customer file is recorded under your name.

iTarang`,
      html:
        `<p>Hi ${esc(name)},</p><p>${esc(admin.name || "iTarang")} created an <b>iTarang House</b> login for you.</p>` +
        `<p>Sign in: <a href="${esc(loginUrl)}">${esc(loginUrl)}</a><br/>Email: <b>${esc(email)}</b><br/>Temporary password: <code style="font-size:15px">${esc(temporaryPassword)}</code></p>` +
        `<p>You will be asked to set your own password the first time you sign in. Every step you take on a customer file is recorded under your name.</p><p>iTarang</p>`,
    });
    emailed = !!res?.messageId && !(res.rejected && res.rejected.length);
  } catch (err) {
    console.warn("[house-team-logins] credentials email failed", err instanceof Error ? err.message : String(err));
  }
  return successResponse({ userId: created.user.id, email, name, temporaryPassword, emailed }, 201);
});

export const PATCH = withErrorHandler(async (req: Request) => {
  const admin = await requireRole(HOUSE_TEAM_LOGIN_ROLES);
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("Pick a login.", 400);
  const h = await house();
  if (!h) return errorResponse("The iTarang house dealer is not set up on this environment.", 500);
  const [login] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, parsed.data.userId), eq(users.dealer_id, h.code), eq(users.role, "dealer")))
    .limit(1);
  if (!login) return errorResponse("That is not a house team login.", 404);

  // E-390 — link / unlink the iTarang sales person who uses this login.
  if (parsed.data.staffUserId !== undefined) {
    if (parsed.data.staffUserId === null) {
      await db.delete(houseLoginStaffLinks).where(eq(houseLoginStaffLinks.login_user_id, login.id));
    } else {
      const ok = (await staffOptions()).some((s) => s.id === parsed.data.staffUserId);
      if (!ok) return errorResponse("Pick an active iTarang team member.", 400);
      await db
        .insert(houseLoginStaffLinks)
        .values({ login_user_id: login.id, staff_user_id: parsed.data.staffUserId, updated_by: admin.id, updated_at: new Date() })
        .onConflictDoUpdate({
          target: houseLoginStaffLinks.login_user_id,
          set: { staff_user_id: parsed.data.staffUserId, updated_by: admin.id, updated_at: new Date() },
        });
    }
  }

  // 23 Nov (point 2): "Can approve" — this login may decide dealer checks.
  if (parsed.data.canApprove !== undefined && parsed.data.userId !== h.sharedUserId) {
    await setHouseApprover(login.id, parsed.data.canApprove);
    console.log(`[house-team-logins] ${admin.id} set canApprove=${parsed.data.canApprove} on ${login.id}`);
  }

  if (parsed.data.active !== undefined) {
    if (parsed.data.userId === h.sharedUserId) {
      return errorResponse("The shared house login can't be switched off here — WhatsApp customer files are created under it.", 409);
    }
    await db.update(users).set({ is_active: parsed.data.active, updated_at: new Date() }).where(eq(users.id, login.id));
  }
  return successResponse({
    userId: parsed.data.userId,
    active: parsed.data.active,
    staffUserId: parsed.data.staffUserId,
    canApprove: parsed.data.canApprove,
  });
});
