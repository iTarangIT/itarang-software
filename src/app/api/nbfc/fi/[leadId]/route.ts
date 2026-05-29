/**
 * GET /api/nbfc/fi/[leadId]
 *
 * Returns the acting NBFC's Field Investigation track for the lead, with a
 * derived sla_breached flag (§6.3) so the UI can surface an overdue visit.
 */
import { NextRequest, NextResponse } from "next/server";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { getFiTrack } from "@/lib/nbfc/fi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  return 500;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: true, track: null, reason: "No assignment for this tenant." });
    }
    const track = await getFiTrack(leadId, assignment.nbfc_id);
    const overdue =
      !!track &&
      !!track.sla_due_at &&
      (track.status === "assigned" || track.status === "in_progress") &&
      new Date(track.sla_due_at).getTime() < Date.now();

    return NextResponse.json({
      ok: true,
      track: track ? { ...track, sla_breached: track.sla_breached || overdue } : null,
      can_act: actor.role === "fi_coordinator" || actor.role === "nbfc_admin",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
