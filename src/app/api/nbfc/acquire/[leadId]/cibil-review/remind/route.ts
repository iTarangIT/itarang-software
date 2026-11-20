/**
 * POST /api/nbfc/acquire/[leadId]/cibil-review/remind
 *   body { message?: string }
 *
 * The approver (or an NBFC admin) reminds the credit verifier(s) that the CIBIL
 * report for this file is not uploaded yet. Bell + email to each verifier;
 * one audit row (nbfc_audit_log 'cibil_review_reminder'). One reminder per
 * minute per file.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { remindCibilVerifier } from "@/lib/nbfc/cibil-review";

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
  message: z.string().trim().max(500).optional().nullable(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    let raw: unknown = {};
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: message is too long (500 characters max)" }, { status: 400 });
    }
    const actor = await resolveActor(req.headers);
    const result = await remindCibilVerifier({ actor, leadId, message: parsed.data.message ?? null });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
