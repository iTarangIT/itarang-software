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
import { z } from "zod";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { nbfcUsers, users } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().email(),
  role: z.string().min(1).max(32).default("viewer"),
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
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

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
      .where(and(eq(nbfcUsers.user_id, userRows[0].id), eq(nbfcUsers.tenant_id, tenant.id)))
      .limit(1);
    if (existing[0]) {
      return NextResponse.json(
        { ok: false, error: "CONFLICT: user already a member of this tenant" },
        { status: 409 },
      );
    }

    await db.insert(nbfcUsers).values({
      user_id: userRows[0].id,
      tenant_id: tenant.id,
      role: parsed.data.role,
      notification_prefs: {},
    });

    return NextResponse.json({ ok: true, user_id: userRows[0].id, tenant_id: tenant.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
