/**
 * DELETE /api/nbfc/users/:id
 *
 * Remove a user's nbfc_users membership for the current tenant. Idempotent.
 */
import { NextResponse } from "next/server";
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
  return 500;
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
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
