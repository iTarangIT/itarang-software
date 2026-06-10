/**
 * PUT /api/nbfc/users/notification-prefs
 *
 * Save the current user's notification preferences for their current tenant.
 * Body: { prefs: { [event]: { email: bool, in_app: bool } } }
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
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

/**
 * Drizzle wraps driver errors as `Failed query: …`; the real Postgres message
 * (and code) live on the `.cause` chain. Surface the deepest cause so the UI
 * shows the actual reason instead of the opaque wrapper.
 */
function unwrapDbError(e: unknown): string {
  let cur: unknown = e;
  let msg = e instanceof Error ? e.message : String(e);
  while (cur instanceof Error && (cur as { cause?: unknown }).cause) {
    cur = (cur as { cause?: unknown }).cause;
    if (cur instanceof Error && cur.message) msg = cur.message;
  }
  return msg;
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
    const msg = unwrapDbError(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
