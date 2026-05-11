/**
 * E-086 — POST /api/nbfc/actions/bulk-immobilisation/initiate
 *
 * BRD §6.4.3 row "Bulk Immobilisation (>5 batteries)": dual-approval gated
 * with Approver 1 = NBFC Risk Head, Approver 2 = iTarang Admin. RBI Digital
 * Lending Directions 2025 elevate bulk recovery actions to a two-person rule.
 *
 * Auth: resolveActor() — production uses Supabase session + nbfc_users role,
 * non-production accepts the triple-guarded test bypass.
 *
 * Caller must hold the 'nbfc_risk_head' role (also accepted: 'risk_head' for
 * back-compat with E-035's role naming).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { initiateBulkImmobilisation } from "@/lib/nbfc/actions/bulk-immobilisation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  loan_application_ids: z.array(z.string().min(1)).min(6),
  reason_code: z.enum(["portfolio_dpd_sweep", "fraud_cluster", "manual"]),
  reviewed_evidence_ack: z.literal(true),
});

const RISK_HEAD_ROLES = new Set(["nbfc_risk_head", "risk_head"]);

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

    if (!RISK_HEAD_ROLES.has(actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_risk_head required to initiate bulk immobilisation`,
        },
        { status: 403 },
      );
    }

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

    const result = await initiateBulkImmobilisation({
      tenant_id: actor.tenant_id,
      initiator_user_id: actor.user_id,
      loan_application_ids: parsed.data.loan_application_ids,
      reason_code: parsed.data.reason_code,
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
