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
 * AuthZ note: the telemetry BRD §6.1.6 specified a 'risk_head' approver, but
 * Addendum V0.2 §7.1 defers the whole Monitor/Recover surface and §7.2 redefines
 * NBFC RBAC to five origination roles with NO 'risk_head' — and states "NBFC
 * Admin … can act on every step." Gating on 'risk_head' alone therefore made
 * this action unreachable (no user in the current model can hold that role).
 * We accept 'nbfc_admin' per V0.2 §7.2, and keep 'risk_head'/'nbfc_risk_head'
 * for back-compat with any legacy nbfc_users rows still carrying it.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { flagLoanForRecovery } from "@/lib/nbfc/recovery/flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  loan_sanction_id: z.string().min(1),
  reason: z.string().min(20),
  battery_serial: z.string().optional(),
  context: z
    .object({
      entity_type: z.enum(["lead", "loan"]),
      lead_id: z.string().min(1).optional(),
      note: z.string().max(500).optional(),
    })
    .optional(),
});

// V0.2 §7.2: NBFC Admin can act on every step. risk_head/nbfc_risk_head kept
// for back-compat with legacy telemetry-era rows.
const FLAG_RECOVERY_ROLES = new Set([
  "nbfc_admin",
  "risk_head",
  "nbfc_risk_head",
]);

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

    if (!FLAG_RECOVERY_ROLES.has(actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_admin required`,
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
      context: parsed.data.context,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
