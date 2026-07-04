/**
 * Live CDS/PCI scoring — computed at read time from the *current* EMI window.
 *
 * The nightly job (computeCds.ts / computePci.ts) writes an immutable snapshot
 * to `borrower_risk_scores` for audit history. But the displayed score must
 * track EMIs as they change (a payment lands, a status flips, a new
 * installment elapses) without waiting for the next nightly run or a manual
 * re-score. So every read surface — the battery list and the explainability
 * drawer — recomputes the score here from the live `emi_schedules` window,
 * using the EXACT same engine helpers the job uses (`computeCdsForLoan`,
 * `pciFromEmis`), so the live number can never drift from the documented
 * formula.
 *
 * Read-only: this never writes. The audit snapshot remains the nightly job's
 * responsibility; this is purely the always-current display value.
 *
 * Scoring window (matches scripts/score-imported-loans.ts and the
 * explainability route): the most recent 6 ELAPSED installments
 * (due on/before today), newest first — the borrower's trailing record.
 */
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import {
  emiSchedules,
  nbfcLoanRestructures,
  telemetryIngestionLog,
} from "@/lib/db/schema";
import {
  CDS_EMI_HISTORY_DEPTH,
  computeCdsForLoan,
  type CdsConfidence,
} from "./computeCds";
import { pciFromEmis } from "../pci/computePci";

type DbLike = typeof defaultDb;

export interface LiveScore {
  cds_score: number;
  pci_score: number;
  confidence: CdsConfidence;
  emi_window: number; // how many elapsed EMIs fed the score (≤ 6)
  computed_at: Date;
}

/**
 * Compute live CDS/PCI for a set of loans in one batch. Returns a map keyed by
 * loan id. Loans with no elapsed EMIs are omitted (the caller shows "—"),
 * matching the "insufficient history" semantics — we never fabricate a 0 for a
 * loan that simply hasn't started repaying.
 */
export async function computeLiveScores(
  tenantId: string,
  loanIds: string[],
  opts?: { db?: DbLike; now?: Date },
): Promise<Map<string, LiveScore>> {
  const dbi = opts?.db ?? defaultDb;
  const now = opts?.now ?? new Date();
  const result = new Map<string, LiveScore>();
  if (loanIds.length === 0) return result;

  const today = now.toISOString().slice(0, 10);

  // All elapsed EMIs for these loans, newest-first. Ordered globally by
  // due_date desc; because that order is stable per loan, grouping in
  // iteration order yields each loan's rows newest-first.
  const emiRows = await dbi
    .select({
      loan_sanction_id: emiSchedules.loan_sanction_id,
      status: emiSchedules.status,
      days_overdue: emiSchedules.days_overdue,
      due_date: emiSchedules.due_date,
      paid_at: emiSchedules.paid_at,
    })
    .from(emiSchedules)
    .where(
      and(
        inArray(emiSchedules.loan_sanction_id, loanIds),
        lte(emiSchedules.due_date, today),
      ),
    )
    .orderBy(desc(emiSchedules.due_date));

  type EmiRow = (typeof emiRows)[number];
  const byLoan = new Map<string, EmiRow[]>();
  for (const r of emiRows) {
    const key = String(r.loan_sanction_id);
    const arr = byLoan.get(key);
    if (arr) {
      if (arr.length < CDS_EMI_HISTORY_DEPTH) arr.push(r);
    } else {
      byLoan.set(key, [r]);
    }
  }

  // Freshest telemetry ingestion for the tenant — one query, shared across all
  // loans (the CDS telemetry term is tenant-level staleness, per the job).
  const [tel] = await dbi
    .select({ ingested_at: telemetryIngestionLog.ingested_at })
    .from(telemetryIngestionLog)
    .where(eq(telemetryIngestionLog.tenant_id, tenantId))
    .orderBy(desc(telemetryIngestionLog.ingested_at))
    .limit(1);
  const telemetryIngestedAt = tel?.ingested_at ?? null;

  // Loans with any restructuring/force-majeure row drop to LOW confidence.
  const restructuredLoans = new Set<string>();
  const restructureRows = await dbi
    .select({ loan_application_id: nbfcLoanRestructures.loan_application_id })
    .from(nbfcLoanRestructures)
    .where(inArray(nbfcLoanRestructures.loan_application_id, loanIds));
  for (const r of restructureRows) {
    if (r.loan_application_id) restructuredLoans.add(String(r.loan_application_id));
  }

  for (const [loanId, emis] of byLoan.entries()) {
    const { cds_score, confidence } = computeCdsForLoan({
      emis: emis.map((e) => ({
        status: e.status,
        days_overdue: e.days_overdue ?? null,
      })),
      telemetryIngestedAt,
      restructuringFlag: restructuredLoans.has(loanId),
      now,
    });
    const pci_score = pciFromEmis(
      emis.map((e) => ({
        due_date: e.due_date,
        paid_at: e.paid_at,
        status: e.status,
        days_overdue: e.days_overdue ?? null,
      })),
    );
    result.set(loanId, {
      cds_score,
      pci_score,
      confidence,
      emi_window: emis.length,
      computed_at: now,
    });
  }

  return result;
}
