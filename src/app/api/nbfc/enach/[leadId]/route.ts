/**
 * GET /api/nbfc/enach/[leadId]
 *
 * Returns the E-NACH track state for a lead's winning NBFC: the disbursal-gate
 * evaluation (§9.4) plus the full attempt history (latest first), with the
 * visible attempt count the BRD asks for to surface a struggling lead.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { enachMandates } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { evaluateEnachGate, getWinningAssignment } from "@/lib/nbfc/enach";

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

    const winner = await getWinningAssignment(leadId);
    const gate = await evaluateEnachGate(leadId);

    let attempts: unknown[] = [];
    if (winner && winner.tenant_id === actor.tenant_id) {
      attempts = await db
        .select()
        .from(enachMandates)
        .where(and(eq(enachMandates.lead_id, leadId), eq(enachMandates.nbfc_id, winner.nbfc_id)))
        .orderBy(desc(enachMandates.created_at));
    }

    return NextResponse.json({
      ok: true,
      gate,
      attempt_count: attempts.length,
      attempts,
      can_waive: actor.role === "credit_underwriting" || actor.role === "nbfc_admin",
      can_act: actor.role === "operations" || actor.role === "nbfc_admin",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
