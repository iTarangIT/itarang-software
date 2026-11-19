/**
 * POST /api/nbfc/acquire/[leadId]/cibil-review/decide
 *   body { decision: "approve" | "approve_with_conditions" | "reject", reason?: string, conditions?: string }
 *
 * E-387 — the parent (or another NBFC admin, never the submitter) approves or
 * rejects the pending CIBIL report. Reject needs a reason and closes the file
 * for this NBFC (same as "Reject file"). E-389: "approve_with_conditions"
 * approves exactly like "approve" and keeps the (required) conditions text.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { decideCibilReview } from "@/lib/nbfc/cibil-review";

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

const Body = z.object({
  decision: z.enum(["approve", "approve_with_conditions", "reject"]),
  reason: z.string().trim().max(2000).optional().nullable(),
  conditions: z.string().trim().max(2000).optional().nullable(),
});

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
    const actor = await resolveActor(req.headers);
    const result = await decideCibilReview({
      actor,
      leadId,
      decision: parsed.data.decision,
      reason: parsed.data.reason ?? null,
      conditions: parsed.data.conditions ?? null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
