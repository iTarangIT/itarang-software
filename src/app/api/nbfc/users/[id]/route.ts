/**
 * DELETE /api/nbfc/users/:id
 *
 * Remove a user's nbfc_users membership for the current tenant. Idempotent.
 *
 * PATCH /api/nbfc/users/:id
 *   body { parent_user_id: uuid | null, delegated_steps: string[],
 *          allowed_nav?: string[] | null, title?: string | null }
 *
 * E-387 — set who this user reports to (parent/child CIBIL approval hierarchy)
 * and which post-approval steps the child may act on. parent_user_id null ⇒ the
 * user is no longer a child. E-388 — allowed_nav = sidebar menus (null ⇒ all),
 * title = designation shown instead of "NBFC Partner"; both left alone when
 * absent. Caller must hold `users.manage`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { assertValidParent, cleanDelegatedSteps } from "@/lib/nbfc/approval-hierarchy";
import { cleanAllowedNav } from "@/lib/nbfc/portal-nav";
import { clientError } from "@/lib/nbfc/http-error";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { nbfcUsers } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess, getSessionUser } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  if (msg.startsWith("NOT_FOUND")) return 404;
  return 500;
}

const PatchBody = z.object({
  parent_user_id: z.string().uuid().nullable(),
  delegated_steps: z.array(z.string()).default([]),
  allowed_nav: z.array(z.string()).nullable().optional(),
  title: z.string().trim().max(64).nullable().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("users.manage")) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: users.manage required" }, { status: 403 });
    }
    const { id } = await ctx.params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const parentUserId = parsed.data.parent_user_id;
    if (parentUserId) await assertValidParent(actor.tenant_id, id, parentUserId);
    const delegated = parentUserId ? cleanDelegatedSteps(parsed.data.delegated_steps) : [];

    const set: {
      parent_user_id: string | null;
      delegated_steps: string[];
      allowed_nav?: string[] | null;
      title?: string | null;
    } = { parent_user_id: parentUserId, delegated_steps: delegated };
    if (parsed.data.allowed_nav !== undefined) {
      const nav = cleanAllowedNav(parsed.data.allowed_nav);
      // Never let an admin lock themselves out of Settings.
      if (id === actor.user_id && nav && !nav.includes("settings")) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: you cannot remove Settings from your own menus" },
          { status: 400 },
        );
      }
      set.allowed_nav = nav;
    }
    if (parsed.data.title !== undefined) set.title = parsed.data.title?.trim() || null;

    const updated = await db
      .update(nbfcUsers)
      .set(set)
      .where(and(eq(nbfcUsers.user_id, id), eq(nbfcUsers.tenant_id, actor.tenant_id)))
      .returning({ user_id: nbfcUsers.user_id });
    if (!updated.length) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: user is not a member of this NBFC" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...set });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);
    const session = await getSessionUser();
    const { id } = await ctx.params;
    if (session && session.id === id) {
      return NextResponse.json(
        { ok: false, error: "CONFLICT: cannot remove yourself" },
        { status: 409 },
      );
    }
    await db
      .delete(nbfcUsers)
      .where(and(eq(nbfcUsers.user_id, id), eq(nbfcUsers.tenant_id, tenant.id)));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
