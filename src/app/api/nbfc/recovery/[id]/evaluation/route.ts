/**
 * E-037 — POST /api/nbfc/recovery/[id]/evaluation
 *
 * BRD §6.1.7 "Battery Evaluation (3-Step Form)". The Recovery operator submits
 * the three-step form for a battery sitting on the recovery pipeline; we
 * persist the evaluation, compute the base auction price deterministically,
 * and advance the pipeline stage to either 'scrap' or 'refurbishable'.
 *
 * AuthN/Z: resolveActor() — production uses the canonical Supabase session +
 * nbfc_users role; non-production accepts the triple-guarded test bypass.
 * Any authenticated NBFC tenant member may call this endpoint (no specific
 * role required by BRD §6.1.7); tenant ownership of the pipeline row is
 * enforced inside recordEvaluation().
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { recordEvaluation } from "@/lib/nbfc/recovery/evaluation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  step1: z.object({
    soh_percent: z.number().min(0).max(100),
    physical_condition: z.enum(["good", "fair", "poor"]),
    manufacturing_date: z.string(),
    iot_status: z.enum(["online", "offline"]),
    bms_health: z.enum(["healthy", "degraded", "failed"]),
    charger_type: z.string(),
  }),
  step2: z.object({
    decision: z.enum(["minor_repair", "cell_replacement", "scrap"]),
    estimated_cost: z.number().nonnegative(),
    checklist: z.object({
      terminal_cleaning: z.boolean(),
      software_recalibration: z.boolean(),
      warranty_reset: z.boolean(),
    }),
  }),
  step3: z.object({
    original_value: z.number().nonnegative(),
    reject: z.boolean().optional(),
  }),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: recoveryPipelineId } = await params;
    if (!recoveryPipelineId) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: missing recovery pipeline id" },
        { status: 400 },
      );
    }

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

    const result = await recordEvaluation({
      tenant_id: actor.tenant_id,
      recovery_pipeline_id: recoveryPipelineId,
      step1: parsed.data.step1,
      step2: parsed.data.step2,
      step3: parsed.data.step3,
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
