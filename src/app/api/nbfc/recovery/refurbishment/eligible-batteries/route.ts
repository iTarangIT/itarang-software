/**
 * E-270 — GET /api/nbfc/recovery/refurbishment/eligible-batteries
 *
 * The batteries an NBFC may put in a refurbishment lot: `inspected`, with a
 * measured SOH, and no open job. Blocked ones are RETURNED with a reason
 * rather than filtered out, so the picker can show why a battery is greyed —
 * "it's not in the list" is the kind of thing that starts a support ticket.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { listEligibleBatteries } from "@/lib/nbfc/recovery/refurbishment-lots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const items = await listEligibleBatteries(actor.tenant_id);
    return NextResponse.json({ ok: true, items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
