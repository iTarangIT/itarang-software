/**
 * E-258 — GET /api/admin/nbfc/scrap/consignments
 *
 * iTarang's inbox of scrap offered by every NBFC. Deliberately NOT tenant
 * scoped: iTarang is the buyer on all of them.
 *
 * VIEW vs TRANSACT. Reading is open to the whole admin role set — the same
 * people who receive the notification should be able to open what it points
 * at. Putting a price on the table, accepting, and paying are gated to
 * `admin` and `ceo` (see SCRAP_DEAL_ROLES in ./[id]/route.ts): money leaving
 * the company is held to the same bar as approving a winning auction bid.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import {
  listConsignments,
  CONSIGNMENT_STATUSES,
} from "@/lib/nbfc/scrap/consignment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) {
      throw new Error("FORBIDDEN: not an admin");
    }

    const url = new URL(req.url);
    // Default to `open`: the inbox exists to show what iTarang still owes an
    // answer or a payment on, and a list dominated by last quarter's settled
    // deals is a different screen.
    const statusParam = url.searchParams.get("status") ?? "open";
    const status = ([...CONSIGNMENT_STATUSES, "open", "all"] as string[]).includes(
      statusParam,
    )
      ? (statusParam as Parameters<typeof listConsignments>[0]["status"])
      : "open";

    const result = await listConsignments({
      tenant_id: null,
      status,
      page: Number(url.searchParams.get("page") ?? 1) || 1,
      page_size: Math.min(
        Number(url.searchParams.get("page_size") ?? 50) || 50,
        100,
      ),
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}
