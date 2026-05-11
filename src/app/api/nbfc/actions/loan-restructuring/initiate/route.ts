/**
 * E-084 — POST /api/nbfc/actions/loan-restructuring/initiate
 *
 * BRD §6.4.3 row "Loan Restructuring": dual approval — Approver 1 NBFC Risk
 * Manager (initiator), Approver 2 NBFC Credit Manager. This endpoint creates
 * a pending dual_approval_requests row capturing the proposed new EMI terms.
 * The actual mutation of `nbfc_loans` happens only when the Credit Manager
 * approves via /api/nbfc/dual-approval/requests/:id/approve, at which point
 * the post-approval dispatcher invokes applyLoanRestructuring().
 *
 * Caller must hold role 'nbfc_risk_manager' (or 'risk_manager' for back-compat).
 *
 * AuthN/Z: resolveActor() — production uses the canonical Supabase session +
 * nbfc_users role; non-production accepts the triple-guarded test bypass
 * (NODE_ENV != production AND server NBFC_TEST_BYPASS_SECRET AND request
 * x-nbfc-test-bypass header).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { initiateLoanRestructuring } from "@/lib/nbfc/actions/loan-restructuring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  loan_application_id: z.string().min(1),
  new_emi_amount: z.number().positive(),
  new_tenure_months: z.number().int().positive(),
  new_emi_due_dom: z.number().int().min(1).max(28),
  reason_code: z.string().min(1),
  reviewed_evidence_ack: z.literal(true),
});

const RISK_MANAGER_ROLES = new Set(["nbfc_risk_manager", "risk_manager"]);

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

    if (!RISK_MANAGER_ROLES.has(actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_risk_manager required`,
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

    const result = await initiateLoanRestructuring({
      tenant_id: actor.tenant_id,
      initiator_user_id: actor.user_id,
      loan_application_id: parsed.data.loan_application_id,
      new_emi_amount: parsed.data.new_emi_amount,
      new_tenure_months: parsed.data.new_tenure_months,
      new_emi_due_dom: parsed.data.new_emi_due_dom,
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
