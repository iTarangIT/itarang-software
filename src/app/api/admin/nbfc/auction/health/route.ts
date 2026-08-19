/**
 * GET /api/admin/nbfc/auction/health
 *
 * Is the auction scheduler alive?
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *   The only thing that closes an auction is an in-process ticker
 *   (`startAuctionTicker`, every 15s, registered in `instrumentation.ts`).
 *   BullMQ is dead code in this repo and Vercel crons do not fire on the pm2
 *   VPS, so if the web process is not running that ticker, nothing anywhere
 *   closes a lot — bidding silently continues past the deadline and no
 *   settlement is ever booked. Two processes are safe (the close is claimed
 *   `FOR UPDATE SKIP LOCKED`); zero is fatal and completely invisible.
 *
 *   There is no tick log table, and adding one for a heartbeat is not worth a
 *   migration. `nbfc_auction_lot_actions` already records every close the
 *   scheduler performs, so the newest `scheduler_close` is a good enough proxy
 *   for "when did this last do something" — and the count of lots sitting past
 *   their own deadline is the symptom that actually matters, which needs no
 *   heartbeat at all.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { clientError } from "@/lib/nbfc/http-error";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) {
      throw new Error("FORBIDDEN: admin role required");
    }

    const [row] = (await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM auction_lots
          WHERE status = 'live' AND ends_at <= now())            AS overdue_lots,
        (SELECT COUNT(*)::int FROM auction_lots
          WHERE status = 'scheduled' AND starts_at <= now())     AS overdue_opens,
        (SELECT MAX(acted_at) FROM nbfc_auction_lot_actions
          WHERE action_code = 'scheduler_close')                 AS last_close_at,
        (SELECT COUNT(*)::int FROM auction_lot_audience
          WHERE status = 'pending')                              AS outbox_pending,
        (SELECT COUNT(*)::int FROM auction_lot_audience
          WHERE status = 'failed')                               AS outbox_failed,
        (SELECT COUNT(*)::int FROM auction_lots WHERE status = 'live')  AS live_lots
    `)) as unknown as Array<Record<string, unknown>>;

    const overdueLots = Number(row?.overdue_lots ?? 0);
    const overdueOpens = Number(row?.overdue_opens ?? 0);

    return NextResponse.json({
      ok: true,
      // A lot past its deadline for more than a tick or two means the ticker is
      // not running. 15s cadence, so anything still here on two consecutive
      // loads of this screen is real.
      healthy: overdueLots === 0 && overdueOpens === 0,
      overdue_lots: overdueLots,
      overdue_opens: overdueOpens,
      live_lots: Number(row?.live_lots ?? 0),
      last_close_at: row?.last_close_at
        ? new Date(String(row.last_close_at)).toISOString()
        : null,
      outbox_pending: Number(row?.outbox_pending ?? 0),
      outbox_failed: Number(row?.outbox_failed ?? 0),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
