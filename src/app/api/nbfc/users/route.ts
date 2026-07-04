/**
 * POST /api/nbfc/users
 *
 * Invite an existing iTarang user to the current NBFC tenant. The invited
 * email must already have a row in the `users` table (i.e. the person already
 * has an iTarang account). On success, inserts an nbfc_users row.
 *
 * Caller must be a member of the tenant via getCurrentTenant() / requireNbfcAccess.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { nbfcRoles, nbfcUsers, users } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { NBFC_ASSIGNABLE_SYSTEM_ROLES } from "@/lib/nbfc/origination-roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().email(),
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

    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    if (!userRows[0]) {
      return NextResponse.json(
        { ok: false, error: `NOT_FOUND: no iTarang user for email ${parsed.data.email}` },
        { status: 404 },
      );
    }

    const existing = await db
      .select({ user_id: nbfcUsers.user_id })
      .from(nbfcUsers)
      .where(and(eq(nbfcUsers.user_id, userRows[0].id), eq(nbfcUsers.tenant_id, tenantId)))
      .limit(1);
    if (existing[0]) {
      return NextResponse.json(
        { ok: false, error: "CONFLICT: user already a member of this tenant" },
        { status: 409 },
      );
    }

    await db.insert(nbfcUsers).values({
      user_id: userRows[0].id,
      tenant_id: tenantId,
      role,
      role_id: roleId,
      notification_prefs: {},
    });

    return NextResponse.json({ ok: true, user_id: userRows[0].id, tenant_id: tenantId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
