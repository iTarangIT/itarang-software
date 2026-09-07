/**
 * DELETE /api/nbfc/acquire/[leadId]
 *
 * E-285 — the lender's half of the multi-party delete. Removes the application
 * from THIS tenant's Acquire pipeline only: the dealer keeps their copy, the
 * admin keeps theirs, and a second lender the lead was routed to still sees its
 * own row. The application is destroyed only once every party has deleted it.
 *
 * Role: nbfc_admin | credit_underwriting — the same pair that may reject a file.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLeadAssignments } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { markLeadDeleted } from "@/lib/leads/multi-party-delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);

    if (actor.role !== "nbfc_admin" && actor.role !== "credit_underwriting") {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' cannot delete an application; nbfc_admin or credit_underwriting required`,
        },
        { status: 403 },
      );
    }

    // Scoped to the actor's tenant: an NBFC can only clear its own row, never
    // another lender's view of the same lead.
    const live = await db
      .select({ id: nbfcLeadAssignments.id })
      .from(nbfcLeadAssignments)
      .where(
        and(
          eq(nbfcLeadAssignments.lead_id, leadId),
          eq(nbfcLeadAssignments.tenant_id, actor.tenant_id),
          isNull(nbfcLeadAssignments.deleted_at),
        ),
      )
      .limit(1);

    if (live.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: no live assignment for this lead under this tenant" },
        { status: 404 },
      );
    }

    const { purged, state } = await markLeadDeleted({
      leadId,
      scope: "nbfc",
      userId: actor.user_id,
      tenantId: actor.tenant_id,
    });

    const waitingOn: string[] = [];
    if (!state.dealerDeletedAt) waitingOn.push("dealer");
    if (state.adminHolds && !state.adminDeletedAt) waitingOn.push("admin");
    if (state.liveNbfcAssignments > 0) waitingOn.push("another lender");

    return NextResponse.json({
      ok: true,
      purged,
      message: purged
        ? "Application deleted."
        : `Removed from your pipeline. Still held by: ${waitingOn.join(", ")}.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
