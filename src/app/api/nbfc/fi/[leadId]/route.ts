/**
 * GET /api/nbfc/fi/[leadId]
 *
 * Returns the acting NBFC's Field Investigation track for the lead, with a
 * derived sla_breached flag (§6.3) so the UI can surface an overdue visit.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcServiceConfig } from "@/lib/db/schema";
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

    // Opt-in state (mirrors the action route): per-lead snapshot first, live
    // config fallback only for pre-snapshot rows (§7.4). Lets the UI show a
    // clear "not opted in" notice rather than a button that 400s on click.
    const snap = assignment.snapshot as { fi_enabled?: boolean };
    let enabled = snap.fi_enabled ?? false;
    if (snap.fi_enabled === undefined) {
      const cfg = await db
        .select({ fi: nbfcServiceConfig.fi_enabled })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      enabled = cfg[0]?.fi ?? false;
    }

    return NextResponse.json({
      ok: true,
      track: track ? { ...track, sla_breached: track.sla_breached || overdue } : null,
      can_act: actor.role === "fi_coordinator" || actor.role === "nbfc_admin",
      enabled,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
