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
import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { emiSchedules, nbfcLoanRestructures, nbfcLoans } from "@/lib/db/schema";
import { getVehicleStates } from "@/lib/db/iot-queries";
import {
  CDS_EMI_HISTORY_DEPTH,
  computeCdsForLoan,
  type CdsConfidence,
} from "./computeCds";
import { pciFromEmis } from "../pci/computePci";

type DbLike = typeof defaultDb;

/**
 * Most recent telemetry contact per loan, read from the LIVE IoT `vehicle_state`
 * (each loan's own battery, via `nbfc_loans.vehicleno`).
 *
 * NOT `telemetry_ingestion_log`: that ledger is only written by the device-push
 * `/api/iot/ingest` path, which is unused in this deployment (telemetry is read
 * live from the IoT DB). It is empty, so every loan saw `telemetryIngestedAt =
 * null` — which pinned CDS confidence at MEDIUM for every borrower (the HIGH
 * branch requires fresh telemetry) and silently zeroed the stale-telemetry risk
 * term. `computePortfolioFreshness` was repointed off the same dead ledger for
 * the same reason; this is that fix applied to scoring.
 *
 * We use `last_gps_at` specifically — the same field the Battery Monitoring
 * freshness badge classifies — so a row's Conf. and Freshness columns agree.
 * GPS is streamed live; `telemetry_battery` is backfilled in daily batches and
 * would read ~12h stale even on a healthy device.
 *
 * If the IoT DB is unreachable we return nulls rather than throwing: scoring
 * degrades to MEDIUM confidence with no telemetry penalty, which is honest — we
 * cannot confirm the battery is reporting.
 */
export async function resolveLoanTelemetryAt(
  tenantId: string,
  loanIds: string[],
  opts?: { db?: DbLike },
): Promise<Map<string, Date | null>> {
  const dbi = opts?.db ?? defaultDb;
  const byLoan = new Map<string, Date | null>();
  if (loanIds.length === 0) return byLoan;

  const loanRows = await dbi
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      vehicleno: nbfcLoans.vehicleno,
    })
    .from(nbfcLoans)
    .where(
      and(
        eq(nbfcLoans.tenant_id, tenantId),
        inArray(nbfcLoans.loan_application_id, loanIds),
        isNotNull(nbfcLoans.vehicleno),
      ),
    );
  if (loanRows.length === 0) return byLoan;

  const vehiclenos = [
    ...new Set(
      loanRows.map((r) => r.vehicleno).filter((v): v is string => !!v),
    ),
  ];

  const lastSeenByVehicle = new Map<string, Date | null>();
  try {
    for (const s of await getVehicleStates(vehiclenos)) {
      lastSeenByVehicle.set(s.vehicleno, s.last_gps_at ?? null);
    }
  } catch {
    // IoT DB unreachable / tunnel down — leave the map empty (all null).
    return byLoan;
  }

  for (const r of loanRows) {
    byLoan.set(
      String(r.loan_application_id),
      lastSeenByVehicle.get(r.vehicleno!) ?? null,
    );
  }
  return byLoan;
}

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

  // Freshest telemetry contact per loan, from that loan's own battery.
  const telemetryByLoan = await resolveLoanTelemetryAt(tenantId, loanIds, {
    db: dbi,
  });

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
      telemetryIngestedAt: telemetryByLoan.get(loanId) ?? null,
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
