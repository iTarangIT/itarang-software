/**
 * E-035 — POST /api/nbfc/actions/flag-for-recovery
 *
 * BRD §6.1.6 row "Flag for Recovery": single Risk Head approval, irreversible
 * permanent flag, recorded in the audit log.
 *
 * AuthN/Z: resolveActor() — production uses the canonical Supabase session +
 * nbfc_users role; non-production accepts the triple-guarded test bypass
 * (NODE_ENV != production AND server NBFC_TEST_BYPASS_SECRET AND request
 * x-nbfc-test-bypass header).
 *
 * Caller must hold the 'risk_head' role (also accepted: 'nbfc_risk_head' for
 * back-compat with E-082's role naming).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { flagLoanForRecovery } from "@/lib/nbfc/recovery/flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  loan_sanction_id: z.string().min(1),
  reason: z.string().min(20),
  battery_serial: z.string().optional(),
});

const RISK_HEAD_ROLES = new Set(["risk_head", "nbfc_risk_head"]);

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
          error: `FORBIDDEN: caller role '${actor.role}' is not authorised; risk_head required`,
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

    const result = await flagLoanForRecovery({
      tenant_id: actor.tenant_id,
      loan_sanction_id: parsed.data.loan_sanction_id,
      reason: parsed.data.reason,
      actor_user_id: actor.user_id ?? null,
      battery_serial: parsed.data.battery_serial ?? null,
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
