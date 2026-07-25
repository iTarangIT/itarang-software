/**
 * POST /api/nbfc/users
 *
 * Add a user to the current NBFC tenant. Two paths:
 *
 *  1. The email already has an iTarang account (a row in `users`) — we simply
 *     link it by inserting an nbfc_users row.
 *  2. The email has NO account yet — we provision a brand-new login: a Supabase
 *     auth user with a generated temp password, a `users` row
 *     (role=nbfc_partner, must_change_password), then the nbfc_users membership.
 *     The one-time password is returned in the response so the NBFC admin can
 *     hand it to the new user; they are forced to change it on first login.
 *
 * This mirrors the many-to-many model (nbfc_users): many logins can map to the
 * same tenant. Caller must hold `users.manage` (the tenant's nbfc_admin).
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { nbfcRoles, nbfcUsers, users } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { NBFC_ASSIGNABLE_SYSTEM_ROLES } from "@/lib/nbfc/origination-roles";
import {
  ensureSupabaseUser,
  generatePortalPassword,
} from "@/lib/nbfc/admin/activate-nbfc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().email(),
  // Optional display name — only used when provisioning a brand-new login.
  name: z.string().trim().min(1).max(200).optional(),
  // Addendum V0.2 §7.2 — five origination roles, plus the Monitor/Recover roles
  // (nbfc_risk_manager / nbfc_risk_head) for the battery-immobilisation gate.
  role: z.enum(NBFC_ASSIGNABLE_SYSTEM_ROLES).default("viewer"),
  // E-162 — optional custom RBAC role (§15.8). When set, `role` is derived from
  // the custom role's base_role for the legacy coarse checks.
  role_id: z.string().uuid().optional().nullable(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("users.manage")) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: users.manage required" }, { status: 403 });
    }
    const tenantId = actor.tenant_id;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    // Resolve a custom role (if given) to its base system role + verify it
    // belongs to this tenant and is active.
    let roleId: string | null = null;
    let role: string = parsed.data.role;
    if (parsed.data.role_id) {
      const [custom] = await db
        .select({ id: nbfcRoles.id, base_role: nbfcRoles.base_role, is_active: nbfcRoles.is_active })
        .from(nbfcRoles)
        .where(and(eq(nbfcRoles.id, parsed.data.role_id), eq(nbfcRoles.tenant_id, tenantId)))
        .limit(1);
      if (!custom || !custom.is_active) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: unknown or inactive custom role" }, { status: 400 });
      }
      roleId = custom.id;
      role = custom.base_role;
    }

    const email = parsed.data.email;

    // Path 1 — the email already has an iTarang account: link it.
    // Path 2 — no account yet: provision a fresh Supabase login + users row and
    // return the one-time password.
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    let userId: string;
    let tempPassword: string | null = null;
    let created = false;

    if (userRows[0]) {
      userId = userRows[0].id;
    } else {
      // Provision a brand-new login bound to this tenant.
      tempPassword = generatePortalPassword();
      try {
        userId = await ensureSupabaseUser(email, tempPassword);
      } catch (err) {
        return NextResponse.json(
          {
            ok: false,
            error: `SUPABASE_USER_PROVISION_FAILED: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          { status: 502 },
        );
      }
      created = true;
      await db
        .insert(users)
        .values({
          id: userId,
          email,
          // users.name is NOT NULL — fall back to the email when no name given.
          name: parsed.data.name ?? email,
          role: "nbfc_partner",
          must_change_password: true,
          is_active: true,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            email,
            role: "nbfc_partner",
            must_change_password: true,
            is_active: true,
            updated_at: new Date(),
          },
        });
    }

    const existing = await db
      .select({ user_id: nbfcUsers.user_id })
      .from(nbfcUsers)
      .where(and(eq(nbfcUsers.user_id, userId), eq(nbfcUsers.tenant_id, tenantId)))
      .limit(1);
    if (existing[0]) {
      return NextResponse.json(
        { ok: false, error: "CONFLICT: user already a member of this tenant" },
        { status: 409 },
      );
    }

    await db.insert(nbfcUsers).values({
      user_id: userId,
      tenant_id: tenantId,
      role,
      role_id: roleId,
      notification_prefs: {},
    });

    return NextResponse.json({
      ok: true,
      user_id: userId,
      tenant_id: tenantId,
      created,
      // Present only when a new login was provisioned — shown once to the admin.
      tempPassword,
      email,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
