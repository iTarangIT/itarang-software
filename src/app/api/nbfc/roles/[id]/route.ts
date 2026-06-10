/**
 * PUT/DELETE /api/nbfc/roles/:id — edit or deactivate a custom NBFC role
 * (BRD Addendum V0.3.1 §15.8). Both require the `roles.manage` permission and
 * are scoped to the actor's tenant. Deactivation is soft (is_active=false) and
 * blocked while users are still assigned — reassign them first (never strand a
 * user on a dead role).
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcRoles, nbfcRolePermissions, nbfcUsers } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { isValidPermission } from "@/lib/nbfc/permissions";

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

const PutBody = z.object({
  name: z.string().min(2).max(64).optional(),
  description: z.string().max(500).optional().nullable(),
  permissions: z.array(z.string()).min(1).optional(),
});

async function loadOwnedRole(roleId: string, tenantId: string) {
  const [role] = await db
    .select()
    .from(nbfcRoles)
    .where(and(eq(nbfcRoles.id, roleId), eq(nbfcRoles.tenant_id, tenantId)))
    .limit(1);
  return role ?? null;
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const actor = await resolveActor(req.headers);
    if (!actor.can("roles.manage")) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: roles.manage required" }, { status: 403 });
    }
    const role = await loadOwnedRole(id, actor.tenant_id);
    if (!role) return NextResponse.json({ ok: false, error: "NOT_FOUND: role" }, { status: 404 });

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = PutBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const d = parsed.data;

    await db.transaction(async (tx) => {
      if (d.name !== undefined || d.description !== undefined) {
        await tx
          .update(nbfcRoles)
          .set({
            ...(d.name !== undefined ? { name: d.name.trim() } : {}),
            ...(d.description !== undefined ? { description: d.description } : {}),
            updated_at: new Date(),
          })
          .where(eq(nbfcRoles.id, id));
      }
      if (d.permissions) {
        const perms = Array.from(new Set(d.permissions)).filter(isValidPermission);
        await tx.delete(nbfcRolePermissions).where(eq(nbfcRolePermissions.role_id, id));
        if (perms.length) {
          await tx.insert(nbfcRolePermissions).values(perms.map((permission_key) => ({ role_id: id, permission_key })));
        }
      }
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const actor = await resolveActor(req.headers);
    if (!actor.can("roles.manage")) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: roles.manage required" }, { status: 403 });
    }
    const role = await loadOwnedRole(id, actor.tenant_id);
    if (!role) return NextResponse.json({ ok: false, error: "NOT_FOUND: role" }, { status: 404 });

    const assignees = await db
      .select({ user_id: nbfcUsers.user_id })
      .from(nbfcUsers)
      .where(and(eq(nbfcUsers.tenant_id, actor.tenant_id), eq(nbfcUsers.role_id, id)))
      .limit(1);
    if (assignees.length > 0) {
      return NextResponse.json(
        { ok: false, error: "CONFLICT: users are still assigned to this role — reassign them before deactivating" },
        { status: 409 },
      );
    }

    await db.update(nbfcRoles).set({ is_active: false, updated_at: new Date() }).where(eq(nbfcRoles.id, id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
