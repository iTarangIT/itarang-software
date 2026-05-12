/**
 * E-036 — PATCH /api/nbfc/recovery/[id]/stage
 *
 * Transitions a recovery-pipeline row to the requested target stage,
 * enforcing the BRD §6.1.7 transition graph and writing an immutable
 * nbfc_audit_log entry capturing before/after state.
 *
 * AuthN/Z: resolveActor() — production uses the canonical Supabase session +
 * nbfc_users role; non-production accepts the triple-guarded test bypass.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { transitionStage } from "@/lib/nbfc/recovery/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  stage: z.enum([
    "needs_inspection",
    "refurbishable",
    "scrap",
    "ready_for_auction",
    "resold",
  ]),
  note: z.string().min(5).optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function PATCH(
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

    const result = await transitionStage({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      recovery_pipeline_id: recoveryPipelineId,
      target_stage: parsed.data.stage,
      note: parsed.data.note,
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
