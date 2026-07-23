/**
 * POST /api/nbfc/acquire/[leadId]/doc-requests/[id]/ack
 *
 * The NBFC acknowledges a pushed request — closes the thread (Change 2, hop T).
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcDocRequests } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { ackNbfcDocRequest } from "@/lib/nbfc/doc-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string; id: string }> },
) {
  try {
    const { leadId, id } = await params;
    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot acknowledge` },
        { status: 403 },
      );
    }
    // Ownership: the wrapper must belong to this tenant + lead.
    const [wrapper] = await db
      .select({ id: nbfcDocRequests.id })
      .from(nbfcDocRequests)
      .where(
        and(
          eq(nbfcDocRequests.id, id),
          eq(nbfcDocRequests.lead_id, leadId),
          eq(nbfcDocRequests.tenant_id, actor.tenant_id),
        ),
      )
      .limit(1);
    if (!wrapper) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: request not found for this tenant" },
        { status: 404 },
      );
    }
    await ackNbfcDocRequest(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
