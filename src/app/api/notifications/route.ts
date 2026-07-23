/**
 * GET/PATCH /api/notifications
 *
 * The generic in-app notification feed for the SIGNED-IN user (Change 5). Reads
 * the `notifications` rows keyed to the session user_id — this is what admin and
 * NBFC users see in the general NotificationBell. (Dealer System-A rows are
 * dealer_id-keyed and served elsewhere.)
 *
 *   GET            → latest notifications + unread count for the current user.
 *   PATCH { ids? } → mark the given ids read (or all when ids omitted).
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.user_id, session.id))
      .orderBy(desc(notifications.created_at))
      .limit(30);
    const unread = rows.filter((r) => !r.read).length;
    return NextResponse.json({ ok: true, notifications: rows, unread });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
    let ids: string[] | undefined;
    try {
      const body = await req.json();
      if (Array.isArray(body?.ids)) ids = body.ids;
    } catch {
      // no body → mark all read
    }
    const now = new Date();
    if (ids && ids.length > 0) {
      await db
        .update(notifications)
        .set({ read: true, read_at: now })
        .where(and(eq(notifications.user_id, session.id), inArray(notifications.id, ids)));
    } else {
      await db
        .update(notifications)
        .set({ read: true, read_at: now })
        .where(and(eq(notifications.user_id, session.id), eq(notifications.read, false)));
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
