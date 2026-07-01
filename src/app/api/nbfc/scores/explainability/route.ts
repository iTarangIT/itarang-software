/**
 * GET /api/nbfc/scores/explainability?loan_sanction_id=...&score_type=cds|pci
 *
 * Backs the CDS/PCI score explainability drawer (BRD §6.4.5):
 *   - the plain-language formula text
 *   - the last-6 EMI input window (newest first) with per-row contribution
 *   - the HIGH/MEDIUM/LOW confidence level + reasons
 *   - the four-item BRD-mandated "when not to trust" list
 *   - whether an override is available
 *
 * Reads the nightly-computed score from `borrower_risk_scores` and the EMI
 * window from `emi_schedules` — the exact tables the CDS / PCI jobs
 * (`computeCds.ts` / `computePci.ts`) write — so the drawer always reflects
 * the inputs behind the displayed number (RBI Digital Lending Directions 2025
 * explainability NFR). Per-row contribution is recomputed with the same
 * weighting helpers the jobs use, so there is no drift.
 *
 * Auth: nbfc-tenant. The `borrower_risk_scores.tenant_id` filter is the
 * isolation gate — a score row exists for the caller's tenant only when the
 * loan belongs to them.
 */
import { NextResponse, type NextRequest } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  borrowerRiskScores,
  emiSchedules,
  nbfcLoanRestructures,
  telemetryIngestionLog,
} from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  computeCdsBreakdown,
  computeCdsForLoan,
  CDS_EMI_WEIGHT_RULES,
  CDS_RECENCY_SCHEDULE,
  CDS_STREAK_RULE,
  CDS_TELEMETRY_RULE,
} from "@/lib/nbfc/cds/computeCds";
import { emiScore, EMI_HISTORY_DEPTH } from "@/lib/nbfc/pci/computePci";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  loan_sanction_id: z.string().min(1),
  score_type: z.enum(["cds", "pci"]),
});

const FORMULA_CDS =
  "CDS = sum of EMI weights × recency multipliers + streak penalty, scaled 0–100";
const FORMULA_PCI =
  "PCI = sum of (EMI score × recency weight) ÷ sum of weights, scaled 0.0–1.0";

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
      loan_sanction_id: url.searchParams.get("loan_sanction_id") ?? "",
      score_type: url.searchParams.get("score_type") ?? "",
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "INVALID_QUERY", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { loan_sanction_id, score_type } = parsed.data;

    const actor = await resolveActor(req.headers);

    // Latest score row for this loan, scoped to the caller's tenant.
    const scoreRows = await db
      .select()
      .from(borrowerRiskScores)
      .where(
        and(
          eq(borrowerRiskScores.tenant_id, actor.tenant_id),
          eq(borrowerRiskScores.loan_sanction_id, loan_sanction_id),
        ),
      )
      .orderBy(desc(borrowerRiskScores.computed_at))
      .limit(1);
    const score = scoreRows[0];
    if (!score) {
      return NextResponse.json(
        { ok: false, error: "SCORE_NOT_COMPUTED" },
        { status: 404 },
      );
    }

    const rawValue = score_type === "cds" ? score.cds_score : score.pci_score;
    if (rawValue === null || rawValue === undefined) {
      return NextResponse.json(
        { ok: false, error: "SCORE_NOT_COMPUTED" },
        { status: 404 },
      );
    }
    const score_value = Number(rawValue);

    // Last 6 ELAPSED EMIs (due on/before today), newest first — the borrower's
    // trailing repayment record, which is the window the score is computed
    // from (see score-imported-loans.ts). Without the `due_date <= today`
    // filter this returned the furthest-FUTURE scheduled installments (all
    // status='scheduled', zero contribution, blank amount/days-late), so the
    // drawer described EMIs that hadn't happened yet.
    const today = new Date().toISOString().slice(0, 10);
    const emis = await db
      .select({
        due_date: emiSchedules.due_date,
        paid_at: emiSchedules.paid_at,
        status: emiSchedules.status,
        days_overdue: emiSchedules.days_overdue,
        amount: emiSchedules.amount,
      })
      .from(emiSchedules)
      .where(
        and(
          eq(emiSchedules.loan_sanction_id, loan_sanction_id),
          lte(emiSchedules.due_date, today),
        ),
      )
      .orderBy(desc(emiSchedules.due_date))
      .limit(6);

    const n = Math.min(emis.length, EMI_HISTORY_DEPTH);
    const pciTotalWeight = (n * (n + 1)) / 2;

    // ---- CDS breakdown (single source of truth shared with the nightly job) --
    // For CDS we reproduce the FULL derivation — per-EMI weight × recency,
    // streak penalty, telemetry term and the 0..100 normalisation — using the
    // freshest telemetry for the caller's tenant and the score's own
    // computed_at as `now`, so the surfaced math reconstructs the same number
    // the job stored (modulo telemetry that has changed since).
    let breakdown: ReturnType<typeof computeCdsBreakdown> | null = null;
    let reference: {
      formula: string;
      emi_weight_rules: typeof CDS_EMI_WEIGHT_RULES;
      recency_schedule: typeof CDS_RECENCY_SCHEDULE;
      streak_rule: string;
      telemetry_rule: string;
    } | null = null;

    if (score_type === "cds") {
      const [tel] = await db
        .select({ ingested_at: telemetryIngestionLog.ingested_at })
        .from(telemetryIngestionLog)
        .where(eq(telemetryIngestionLog.tenant_id, actor.tenant_id))
        .orderBy(desc(telemetryIngestionLog.ingested_at))
        .limit(1);
      breakdown = computeCdsBreakdown({
        emis: emis.map((e) => ({
          status: e.status,
          days_overdue: e.days_overdue ?? null,
        })),
        telemetryIngestedAt: tel?.ingested_at ?? null,
        now: score.computed_at,
      });
      reference = {
        formula: FORMULA_CDS,
        emi_weight_rules: CDS_EMI_WEIGHT_RULES,
        recency_schedule: CDS_RECENCY_SCHEDULE,
        streak_rule: CDS_STREAK_RULE,
        telemetry_rule: CDS_TELEMETRY_RULE,
      };
    }

    // Per-row inputs. CDS rows carry the weight × recency terms straight from
    // the breakdown (same index order); PCI keeps its recency-weighted score.
    const last_6_emis = emis.map((e, idx) => {
      const days = e.days_overdue ?? null;
      let contribution: number;
      let emi_weight: number | null = null;
      let recency_multiplier: number | null = null;
      if (score_type === "cds") {
        const row = breakdown!.per_emi[idx];
        emi_weight = row?.emi_weight ?? null;
        recency_multiplier = row?.recency_multiplier ?? null;
        contribution = row?.contribution ?? 0;
      } else {
        const weight = n - idx; // most-recent gets the highest weight
        contribution =
          pciTotalWeight > 0
            ? (emiScore({
                due_date: e.due_date,
                paid_at: e.paid_at,
                status: e.status,
                days_overdue: days,
              }) *
                weight) /
              pciTotalWeight
            : 0;
      }
      return {
        due_date: e.due_date ? new Date(e.due_date).toISOString() : null,
        amount: e.amount != null ? Number(e.amount) : null,
        status: e.status ?? null,
        days_late: days,
        emi_weight,
        recency_multiplier,
        contribution: Math.round(contribution * 100) / 100,
      };
    });

    // Confidence: persisted on the borrower_risk_scores row by the CDS job.
    const persisted = (score.confidence ?? "").toUpperCase();
    let level: "HIGH" | "MEDIUM" | "LOW" =
      persisted === "HIGH" || persisted === "MEDIUM" || persisted === "LOW"
        ? (persisted as "HIGH" | "MEDIUM" | "LOW")
        : emis.length < 3
          ? "LOW"
          : "MEDIUM";

    const reasons: string[] = [];
    if (emis.length < 3) reasons.push("Insufficient history (<3 EMIs)");

    // Restructuring drops confidence and is itself a "do not trust" reason.
    const restructures = await db
      .select({ id: nbfcLoanRestructures.id })
      .from(nbfcLoanRestructures)
      .where(eq(nbfcLoanRestructures.loan_application_id, loan_sanction_id))
      .limit(1);
    if (restructures.length > 0) {
      reasons.push("Recent restructuring");
      if (level === "HIGH") level = "MEDIUM";
    }

    return NextResponse.json({
      ok: true,
      score_type,
      score_value,
      formula_text: score_type === "cds" ? FORMULA_CDS : FORMULA_PCI,
      inputs: { last_6_emis },
      breakdown,
      reference,
      confidence: { level, reasons },
      when_not_to_trust: [...WHEN_NOT_TO_TRUST],
      override: { available: true, required_role: "nbfc_risk_manager" },
      computed_at: score.computed_at.toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
