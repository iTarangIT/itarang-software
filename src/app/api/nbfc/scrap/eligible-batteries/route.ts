/**
 * E-258 — GET /api/nbfc/scrap/eligible-batteries
 *
 * The picker behind "new scrap consignment": every battery this NBFC holds
 * that is scrap and is not already committed to a live consignment.
 *
 * Scrap means EITHER `recovery_batteries.state_code = 'scrapped'` OR the
 * battery's pipeline row reached the terminal `scrap` stage — both, because
 * moving a pipeline row to `scrap` has never touched the battery's own state,
 * so either alone would hide most of the real scrap. See the service.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { listEligibleBatteries } from "@/lib/nbfc/scrap/consignment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const items = await listEligibleBatteries(actor.tenant_id);
    return NextResponse.json({ ok: true, items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    return NextResponse.json({ ok: false, error: clientError(e) }, { status });
  }
}
