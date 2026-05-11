/**
 * PUT /api/nbfc/users/notification-prefs
 *
 * Save the current user's notification preferences for their current tenant.
 * Body: { prefs: { [event]: { email: bool, in_app: bool } } }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { nbfcUsers } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess, getSessionUser } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChannelPrefs = z.object({ email: z.boolean(), in_app: z.boolean() });
const Body = z.object({ prefs: z.record(z.string(), ChannelPrefs) });

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  return 500;
}

export async function PUT(req: NextRequest) {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json(
        { ok: false, error: "UNAUTHORIZED: no session" },
        { status: 401 },
      );
    }

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

    const updated = await db
      .update(nbfcUsers)
      .set({ notification_prefs: parsed.data.prefs })
      .where(and(eq(nbfcUsers.user_id, session.id), eq(nbfcUsers.tenant_id, tenant.id)))
      .returning({ user_id: nbfcUsers.user_id });

    if (updated.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: no membership for current user" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
