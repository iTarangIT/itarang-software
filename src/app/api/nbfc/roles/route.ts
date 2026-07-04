/**
 * GET/POST /api/nbfc/roles — NBFC Custom RBAC (BRD Addendum V0.3.1 §15.8).
 *
 *   GET  → the permission catalogue, the 5 read-only system roles (with their
 *          default permissions + headcount), and this tenant's custom roles.
 *   POST → create a custom role (typically cloned from a system role's defaults,
 *          then tweaked). Requires the `roles.manage` permission.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcRoles, nbfcRolePermissions, nbfcUsers } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  NBFC_ORIGINATION_ROLES,
  NBFC_ROLE_LABELS,
} from "@/lib/nbfc/origination-roles";
import {
  NBFC_PERMISSION_GROUPS,
  defaultPermissionsForRole,
  isValidPermission,
} from "@/lib/nbfc/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const CreateBody = z.object({
  name: z.string().min(2).max(64),
  base_role: z.enum(NBFC_ORIGINATION_ROLES),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string()).min(1),
});

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    const members = await db
      .select({ role: nbfcUsers.role, role_id: nbfcUsers.role_id })
      .from(nbfcUsers)
      .where(eq(nbfcUsers.tenant_id, actor.tenant_id));

    const customRows = await db
      .select()
      .from(nbfcRoles)
      .where(eq(nbfcRoles.tenant_id, actor.tenant_id));
    const permRows = customRows.length
      ? await db.select().from(nbfcRolePermissions)
      : [];
    const permsByRole = new Map<string, string[]>();
    for (const p of permRows) {
      const arr = permsByRole.get(p.role_id) ?? [];
      arr.push(p.permission_key);
      permsByRole.set(p.role_id, arr);
    }

    // Headcounts: a member with role_id counts toward that custom role; otherwise
    // toward their system role string.
    const systemCount = new Map<string, number>();
    const customCount = new Map<string, number>();
    for (const m of members) {
      if (m.role_id) customCount.set(m.role_id, (customCount.get(m.role_id) ?? 0) + 1);
      else systemCount.set(m.role, (systemCount.get(m.role) ?? 0) + 1);
    }

    const systemRoles = NBFC_ORIGINATION_ROLES.map((key) => ({
      key,
      label: NBFC_ROLE_LABELS[key],
      permissions: defaultPermissionsForRole(key),
      users: systemCount.get(key) ?? 0,
    }));
    const customRoles = customRows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      base_role: r.base_role,
      is_active: r.is_active,
      permissions: permsByRole.get(r.id) ?? [],
      users: customCount.get(r.id) ?? 0,
    }));

    return NextResponse.json({
      ok: true,
      canEdit: actor.can("roles.manage"),
      catalogue: NBFC_PERMISSION_GROUPS,
      systemRoles,
      customRoles,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("roles.manage")) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: roles.manage required" }, { status: 403 });
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = CreateBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const d = parsed.data;
    const perms = Array.from(new Set(d.permissions)).filter(isValidPermission);
    if (perms.length === 0) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no valid permissions" }, { status: 400 });
    }

    const [role] = await db
      .insert(nbfcRoles)
      .values({
        tenant_id: actor.tenant_id,
        name: d.name.trim(),
        description: d.description ?? null,
        base_role: d.base_role,
        created_by: actor.user_id,
      })
      .returning();
    await db.insert(nbfcRolePermissions).values(perms.map((permission_key) => ({ role_id: role.id, permission_key })));

    return NextResponse.json({ ok: true, id: role.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
