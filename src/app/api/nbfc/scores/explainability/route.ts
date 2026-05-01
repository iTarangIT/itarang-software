/**
 * GET /api/nbfc/scores/explainability?loan_application_id=...&score_type=cds|pci
 *
 * Returns the data backing the CDS/PCI score explainability drawer
 * (BRD §6.4.5, unit E-092):
 *   - the plain-language formula text
 *   - the last-6 EMI input snapshot tied to the most-recent score run
 *   - the deterministic confidence level + reasons
 *   - the four-item BRD-mandated "when not to trust" list
 *   - whether an override is available on this loan
 *
 * Auth: nbfc-tenant — caller must be a member of the tenant that owns the
 * loan, or admin/ceo.
 *
 * The score itself comes from a pre-computed row in `nbfc_score_runs` (written
 * by whichever job produced the CDS/PCI value); this endpoint never re-runs
 * the math. That is the whole point of E-092: the drawer always reflects the
 * exact inputs that produced the displayed score, so the surface is
 * RBI-Digital-Lending-Directions-2025-explainable by construction.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfcLoans,
  nbfcScoreRuns,
  nbfcScoreInputSnapshots,
  nbfcBorrowerActions,
} from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  loan_application_id: z.string().min(1),
  score_type: z.enum(["cds", "pci"]),
});

const FORMULA_CDS =
  "CDS = sum of EMI weights × recency multipliers + streak penalty, scaled 0–100";
const FORMULA_PCI =
  "PCI = predictive component index, blending CDS trajectory with telemetry signals, scaled 0–100";

const WHEN_NOT_TO_TRUST = [
  "Insufficient history (<3 EMIs)",
  "Recent restructuring",
  "Declared force majeure",
  "Manual override active",
] as const;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      loan_application_id: url.searchParams.get("loan_application_id") ?? "",
      score_type: url.searchParams.get("score_type") ?? "",
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "INVALID_QUERY", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { loan_application_id, score_type } = parsed.data;

    const actor = await resolveActor(req.headers);

    // Ensure the loan belongs to this tenant — prevents cross-tenant probing
    // via a known loan_application_id.
    const loan = await db
      .select({
        loan_application_id: nbfcLoans.loan_application_id,
        tenant_id: nbfcLoans.tenant_id,
      })
      .from(nbfcLoans)
      .where(
        and(
          eq(nbfcLoans.tenant_id, actor.tenant_id),
          eq(nbfcLoans.loan_application_id, loan_application_id),
        ),
      )
      .limit(1);
    if (!loan[0]) {
      return NextResponse.json(
        { ok: false, error: "LOAN_NOT_FOUND" },
        { status: 404 },
      );
    }

    // Latest score run for (loan, score_type).
    const runRows = await db
      .select()
      .from(nbfcScoreRuns)
      .where(
        and(
          eq(nbfcScoreRuns.loan_application_id, loan_application_id),
          eq(nbfcScoreRuns.score_type, score_type),
        ),
      )
      .orderBy(desc(nbfcScoreRuns.computed_at))
      .limit(1);
    const run = runRows[0];
    if (!run) {
      return NextResponse.json(
        { ok: false, error: "SCORE_NOT_COMPUTED" },
        { status: 404 },
      );
    }

    // Snapshot rows — newest first, capped to 6 (BRD says "last 6 EMIs").
    const snapshotRows = await db
      .select()
      .from(nbfcScoreInputSnapshots)
      .where(eq(nbfcScoreInputSnapshots.score_run_id, run.id))
      .orderBy(desc(nbfcScoreInputSnapshots.due_date));

    const last_6_emis = snapshotRows.slice(0, 6).map((r) => ({
      due_date: r.due_date ? r.due_date.toISOString() : null,
      amount: r.amount === null ? null : Number(r.amount),
      status: r.status ?? null,
      days_late: r.days_late ?? null,
      contribution: r.contribution === null ? null : Number(r.contribution),
    }));

    // Override availability: any active override row in nbfc_borrower_actions
    // (action_type='score_override', status='active') against this loan
    // disables the override CTA and is itself a "not to trust" reason.
    const overrideRows = await db
      .select({ id: nbfcBorrowerActions.id })
      .from(nbfcBorrowerActions)
      .where(
        and(
          eq(nbfcBorrowerActions.tenant_id, actor.tenant_id),
          eq(nbfcBorrowerActions.loan_sanction_id, loan_application_id),
          eq(nbfcBorrowerActions.action_type, "score_override"),
          eq(nbfcBorrowerActions.status, "active"),
        ),
      )
      .limit(1);
    const override_active = overrideRows.length > 0;

    const formula_text = score_type === "cds" ? FORMULA_CDS : FORMULA_PCI;

    // Confidence level: trust the persisted value if present (the writer is
    // canonical per BRD §6.4.5 NFR), otherwise derive from snapshot count.
    const persistedReasons = Array.isArray(run.confidence_reasons)
      ? (run.confidence_reasons as string[])
      : [];
    const reasons = new Set<string>(persistedReasons);
    if (snapshotRows.length < 3) reasons.add("Insufficient history (<3 EMIs)");
    if (override_active) reasons.add("Manual override active");

    let level: "HIGH" | "MEDIUM" | "LOW";
    if (run.confidence_level && ["HIGH", "MEDIUM", "LOW"].includes(run.confidence_level)) {
      // Persisted value wins, but an active override always demotes to LOW
      // because the score the user is looking at no longer drives decisioning.
      level = override_active
        ? "LOW"
        : (run.confidence_level as "HIGH" | "MEDIUM" | "LOW");
    } else {
      level = snapshotRows.length < 3 || override_active ? "LOW" : "HIGH";
    }
    if (level === "HIGH" && reasons.size > 0) level = "MEDIUM";

    return NextResponse.json({
      ok: true,
      score_type,
      score_value: Number(run.score_value),
      formula_text,
      inputs: {
        last_6_emis,
      },
      confidence: {
        level,
        reasons: Array.from(reasons),
      },
      when_not_to_trust: [...WHEN_NOT_TO_TRUST],
      override: {
        available: !override_active,
        required_role: "nbfc_risk_manager",
      },
      computed_at: run.computed_at.toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
