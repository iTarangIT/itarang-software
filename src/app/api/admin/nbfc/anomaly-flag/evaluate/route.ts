/**
 * POST /api/admin/nbfc/anomaly-flag/evaluate  (E-066 — BRD §6.3.2)
 *
 * Admin-only. Evaluates per-NBFC comparison metrics derived from `nbfc_loans`
 * (delinquency_pct, recovery_rate_pct, avg_dpd) against E-066 thresholds and
 * upserts/clears `nbfc_anomaly_flags` rows accordingly.
 *
 * Request body (zod-validated):
 *   { nbfc_id?: string (uuid) }   — when provided, evaluate only that tenant
 *
 * Response:
 *   { evaluated_count: number,
 *     flagged: [{ nbfc_id, severity: 'red'|'amber', reasons: string[] }],
 *     cleared: string[] }
 *
 * Auth: shares the canonical NBFC admin idiom (resolveAdminActor) — non-admins
 * receive 403.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { evaluateAnomalyFlags } from "@/lib/nbfc/anomalyFlags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z
  .object({
    nbfc_id: z.string().uuid().optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    await resolveAdminActor(req.headers);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }

  let parsed: z.infer<typeof RequestSchema> = {};
  try {
    const text = await req.text();
    if (text) {
      const json = JSON.parse(text);
      const r = RequestSchema.safeParse(json);
      if (!r.success) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST", issues: r.error.issues },
          { status: 400 },
        );
      }
      parsed = r.data;
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  try {
    const result = await evaluateAnomalyFlags(parsed.nbfc_id);
    return NextResponse.json({
      ok: true,
      evaluated_count: result.evaluated_count,
      flagged: result.flagged.map((f) => ({
        nbfc_id: f.nbfc_id,
        severity: f.severity,
        reasons: f.reasons,
      })),
      cleared: result.cleared,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin/nbfc/anomaly-flag/evaluate] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
