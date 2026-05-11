/**
 * E-093 — Score override with documented reason.
 *
 * POST /api/nbfc/scores/override
 *   Body: { loan_application_id, score_type, override_value, reason,
 *           computed_score_value? }
 *   - Caller MUST be role 'nbfc_risk_manager' (else 403).
 *   - reason length must be 20..1000 chars.
 *   - computed_score_value is the snapshot of the score at the time of the
 *     override. Optional in the request because E-092 (which stores the
 *     computed score in nbfc_score_runs / borrower_risk_scores) is not yet a
 *     hard dependency at HEAD. Defaults to 0 if omitted.
 *   - Any existing active override for the same (loan_application_id,
 *     score_type) is flipped to is_active=false; the new row becomes active.
 *   - Writes audit_logs with action='score.override.created'.
 *
 * GET /api/nbfc/scores/override?loan_application_id=...&score_type=cds|pci
 *   - Returns { active_override, history } (history newest-first).
 *
 * AuthN/Z reuses the dual-approval `resolveActor` primitive: it honours
 * Supabase session in production AND the triple-guarded test bypass for the
 * NBFC self-coding loop's API tests.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  RISK_MANAGER_ROLE,
  SCORE_TYPES,
  MIN_REASON_LEN,
  MAX_REASON_LEN,
  createScoreOverride,
  getScoreOverrides,
} from "@/lib/nbfc/scores/override-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBody = z.object({
  loan_application_id: z.string().min(1),
  score_type: z.enum(SCORE_TYPES),
  override_value: z.number().min(0).max(100),
  reason: z.string().min(MIN_REASON_LEN).max(MAX_REASON_LEN),
  // Optional snapshot of the computed score at override time. The unit YAML
  // describes loading this from nbfc_score_runs (E-092), which is not yet a
  // hard dependency at HEAD; we accept it from the client as a snapshot.
  computed_score_value: z.number().min(0).max(100).optional(),
});

const ListQuery = z.object({
  loan_application_id: z.string().min(1),
  score_type: z.enum(SCORE_TYPES),
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

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "VALIDATION",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    if (actor.role !== RISK_MANAGER_ROLE) {
      return NextResponse.json(
        {
          ok: false,
          error: "FORBIDDEN: only nbfc_risk_manager may override scores",
        },
        { status: 403 },
      );
    }

    const row = await createScoreOverride({
      tenant_id: actor.tenant_id,
      loan_application_id: parsed.data.loan_application_id,
      score_type: parsed.data.score_type,
      computed_score_value: parsed.data.computed_score_value ?? 0,
      override_value: parsed.data.override_value,
      reason: parsed.data.reason,
      created_by: actor.user_id,
    });

    return NextResponse.json(row, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    await resolveActor(req.headers);
    const url = new URL(req.url);
    const parsed = ListQuery.safeParse({
      loan_application_id: url.searchParams.get("loan_application_id") ?? "",
      score_type: url.searchParams.get("score_type") ?? "",
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = await getScoreOverrides({
      loan_application_id: parsed.data.loan_application_id,
      score_type: parsed.data.score_type,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
