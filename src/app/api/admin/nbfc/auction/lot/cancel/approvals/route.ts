/**
 * E-234 — GET /api/admin/nbfc/auction/lot/cancel/approvals
 *
 * The pending cancel-lot queue, for the second admin in the dual-approval
 * pair.
 *
 * THIS ROUTE WAS MISSING. `CancelLotApprovalQueue.tsx` has fetched this exact
 * path since E-070 and `listPendingCancelRequests()` has existed to serve it
 * for just as long — but nothing ever wired the two together. The component
 * treats a non-2xx as "no rows", so the queue rendered "No pending cancel-lot
 * requests." forever, including while requests were genuinely pending. The
 * dual-approval gate was therefore not slow, it was unreachable.
 *
 * The lot code is joined in because a bare lot uuid tells the approving admin
 * nothing about what they are being asked to destroy.
 *
 * 200 → { requests: [...] }
 * 401 → not signed in
 * 403 → not an admin
 */
import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { auctionLots } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import { listPendingCancelRequests } from "@/lib/nbfc/admin/auctionCancelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) {
      throw new Error("FORBIDDEN: not an admin");
    }

    const requests = await listPendingCancelRequests();
    const lotIds = [...new Set(requests.map((r) => r.lot_id))];
    const lots = lotIds.length
      ? await db
          .select({
            id: auctionLots.id,
            lot_code: auctionLots.lot_code,
            title: auctionLots.title,
            status: auctionLots.status,
          })
          .from(auctionLots)
          .where(inArray(auctionLots.id, lotIds))
      : [];
    const lotById = new Map(lots.map((l) => [l.id, l]));

    return NextResponse.json({
      requests: requests
        .map((r) => ({
          ...r,
          requested_at:
            r.requested_at instanceof Date
              ? r.requested_at.toISOString()
              : r.requested_at,
          lot_code: lotById.get(r.lot_id)?.lot_code ?? null,
          lot_title: lotById.get(r.lot_id)?.title ?? null,
          lot_status: lotById.get(r.lot_id)?.status ?? null,
          // The queue's whole purpose is that a SECOND admin decides. The
          // server enforces this (403 on self-approval); flagging it here lets
          // the UI disable the button instead of inviting a click that fails.
          is_own_request: r.requested_by === actor.user_id,
        }))
        .sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at))),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
