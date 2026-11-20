/**
 * POST /api/nbfc/acquire/[leadId]/reject   body { note: string }
 *
 * E-275 — the NBFC rejects the whole file. The assignment goes 'declined'
 * (decision_reason 'nbfc_rejected'), any firm offer is withdrawn, and the
 * rejection waits with the ADMIN — the dealer hears nothing until an admin
 * forwards it (or the rejection SLA does). Role: credit_underwriting | nbfc_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { hierarchyBlock } from "@/lib/nbfc/approval-hierarchy-http";
import { rejectNbfcFile } from "@/lib/nbfc/reject-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  if (msg.startsWith("CONFLICT")) return 409;
  return 500;
}

const Body = z.object({ note: z.string().trim().min(1).max(2000) });

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
    const note = parsed.data.note;

    const actor = await resolveActor(req.headers);
    // E-387 — parent/child CIBIL approval hierarchy gate.
    const hierarchyBlocked = await hierarchyBlock(actor, leadId, "reject");
    if (hierarchyBlocked) return hierarchyBlocked;
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot reject a file; credit_underwriting or nbfc_admin required` },
        { status: 403 },
      );
    }

    const { dueAt } = await rejectNbfcFile({ actor, leadId, note });

    return NextResponse.json({
      ok: true,
      status: "declined",
      rejection_admin_due_at: dueAt?.toISOString() ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
