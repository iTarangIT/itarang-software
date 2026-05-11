/**
 * E-083 — POST /api/nbfc/actions/battery-immobilisation/initiate
 *
 * BRD §6.4.3: Battery immobilisation is a borrower-impacting recovery action
 * gated by the dual-approval primitive (E-082). Risk Manager initiates here;
 * Risk Head approves at /api/nbfc/dual-approval/requests/:id/approve. The
 * action handler runs ONLY after the upstream approval transitions to
 * 'approved' — there is no direct execution path here.
 *
 * AuthN/Z: resolveActor() (canonical NBFC session OR triple-guarded test
 * bypass). Caller must have role 'nbfc_risk_manager'.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { initiateImmobilisation } from "@/lib/nbfc/actions/battery-immobilisation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  loan_application_id: z.string().min(1),
  imei: z.string().min(1),
  reason_code: z.enum(["dpd_60", "dpd_90", "fraud_flag", "manual"]),
  borrower_notice_id: z.string().optional(),
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

    const result = await initiateImmobilisation({
      tenant_id: actor.tenant_id,
      initiator_user_id: actor.user_id,
      loan_application_id: parsed.data.loan_application_id,
      imei: parsed.data.imei,
      reason_code: parsed.data.reason_code,
      borrower_notice_id: parsed.data.borrower_notice_id ?? null,
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
