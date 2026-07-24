/**
 * POST /api/nbfc/vkyc/[leadId]/action
 *
 * §10 admin verification card decision — Operations accepts or rejects the
 * decoded Video KYC result. Reject requires notes. Role: operations | nbfc_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { notifyVkycEvent } from "@/lib/notifications/events";
import { tenantDisplayName } from "@/lib/notifications/emit";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { videoKycVerifications } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment, getVkycTrack } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ action: z.enum(["accept", "reject"]), notes: z.string().max(2000).optional() });

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    if (parsed.data.action === "reject" && !parsed.data.notes?.trim()) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: notes required to reject" }, { status: 400 });
    }

    const actor = await resolveActor(req.headers);
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json({ ok: false, error: `FORBIDDEN: role '${actor.role}' cannot action VKYC` }, { status: 403 });
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this tenant" }, { status: 400 });
    }
    const track = await getVkycTrack(leadId, assignment.nbfc_id);
    if (!track) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: no VKYC track" }, { status: 404 });
    }

    const now = new Date();
    await db
      .update(videoKycVerifications)
      .set({
        admin_action: parsed.data.action === "accept" ? "accepted" : "rejected",
        admin_action_by: actor.user_id,
        admin_action_at: now,
        admin_action_notes: parsed.data.notes ?? null,
        // Accepting confirms verified; rejecting marks the track failed.
        status: parsed.data.action === "accept" ? "verified" : "failed",
        updated_at: now,
      })
      .where(eq(videoKycVerifications.id, track.id));

    await notifyVkycEvent({
      leadId,
      event: parsed.data.action === "accept" ? "approved" : "rejected",
      nbfcName: await tenantDisplayName(actor.tenant_id),
      tenantId: actor.tenant_id,
      reason: parsed.data.notes ?? null,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
