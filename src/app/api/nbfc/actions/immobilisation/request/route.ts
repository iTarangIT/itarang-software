/**
 * E-033 — POST /api/nbfc/actions/immobilisation/request
 *
 * BRD §6.1.6 row "Request Immobilisation": Dual approval (Risk Head + Ops),
 * reversible (re-mobilisation after EMI settlement), full borrower notice
 * preview required (RBI Digital Lending Directions 2025).
 *
 * AuthN/Z: resolveActor() — production uses canonical Supabase session +
 * nbfc_users role; non-production accepts the triple-guarded test bypass.
 * Caller MUST have role 'nbfc_risk_head'.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { requestImmobilisation } from "@/lib/nbfc/actions/request-immobilisation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  loan_sanction_id: z.string().uuid(),
  notice_confirmed: z.literal(true),
  notice_text: z.string().min(50),
  outstanding_amount: z.number().nonnegative(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

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

    const result = await requestImmobilisation({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      actor_role: actor.role,
      loan_sanction_id: parsed.data.loan_sanction_id,
      notice_confirmed: parsed.data.notice_confirmed,
      notice_text: parsed.data.notice_text,
      outstanding_amount: parsed.data.outstanding_amount,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
