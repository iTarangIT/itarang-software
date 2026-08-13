/**
 * POST /api/nbfc/acquire/[leadId]/doc-requests/[id]/reply
 *
 * E-239 — the NBFC adds another message to a DIRECT (dealer_direct) thread: a
 * clarification, or a follow-up after the dealer sent the wrong document. The
 * thread is pulled back to 'forwarded_to_dealer' so it reappears on the dealer's
 * Step-4 card, and the dealer is notified.
 *
 * Restricted to direct threads on purpose. An admin-gated wrapper's return leg
 * runs through /api/admin/nbfc-requests, and letting the NBFC post into it here
 * would put messages on a thread the dealer cannot see.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { nbfcDocRequests } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  appendRequestMessage,
  markDirectRequestReopened,
  NBFC_DOC_STATUS,
} from "@/lib/nbfc/doc-requests";
import { notifyNbfcDocRequestDirect } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const Body = z.object({
  message: z.string().trim().min(1).max(4000),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string; id: string }> },
) {
  try {
    const { leadId, id } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot reply` },
        { status: 403 },
      );
    }

    // Ownership: the wrapper must belong to this tenant + lead.
    const [wrapper] = await db
      .select({
        id: nbfcDocRequests.id,
        status: nbfcDocRequests.status,
        dealer_direct: nbfcDocRequests.dealer_direct,
      })
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
    if (!wrapper.dealer_direct) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: this request is routed through the iTarang admin — reply from the admin thread instead",
        },
        { status: 400 },
      );
    }
    if (wrapper.status === NBFC_DOC_STATUS.CLOSED) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: this thread is closed" },
        { status: 400 },
      );
    }

    await appendRequestMessage({
      requestId: id,
      leadId,
      party: "nbfc",
      authorUserId: actor.user_id,
      message: parsed.data.message,
    });
    await markDirectRequestReopened(id);

    await notifyNbfcDocRequestDirect({
      leadId,
      requestId: id,
      nbfcName: actor.tenant_slug,
      comments: parsed.data.message,
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
