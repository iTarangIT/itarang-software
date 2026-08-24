/**
 * POST /api/nbfc/actions/unflag-recovery — withdraw a recovery flag.
 *
 * The mirror of /api/nbfc/actions/flag-for-recovery. BRD §6.1.6 described the
 * flag as permanent, which in practice meant an operator who flagged the wrong
 * loan had no route back at all. The reversal is scoped so that it corrects a
 * mistake without rewriting history: it is refused the moment recovery has
 * physically started (see unflagLoanForRecovery), and it appends its own
 * `unflag_for_recovery` audit row rather than deleting the original flag.
 *
 * AuthN/Z is identical to the flag route — same roles, same resolveActor()
 * path — because withdrawing a flag is exactly as consequential as raising it.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { unflagLoanForRecovery } from "@/lib/nbfc/recovery/flag";

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

// Same set as the flag route: V0.2 §7.2 NBFC Admin acts on every step,
// risk_head/nbfc_risk_head kept for legacy telemetry-era rows.
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
        { ok: false, error: validationError(parsed.error), issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await unflagLoanForRecovery({
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
