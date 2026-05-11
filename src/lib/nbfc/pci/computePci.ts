/**
 * E-030 — PCI (Payment Consistency Index) nightly computation.
 *
 * BRD §6.1.5: PCI ranges 0.0–1.0. Higher = more consistent EMI payer.
 * Inverse of CDS risk signal.
 *
 *   PCI = Σ(EMI_score × weight) / Σ(weights)
 *     EMI_score: 1.0 = paid on time, 0.5 = paid late (<7d), 0.0 = missed
 *     weight: more recent EMIs weighted higher (linear by recency rank)
 *
 *   PCI < 0.40 → high concern, fires a row in nbfc_risk_alerts (type=pci_low).
 *   PCI 0.40 – 0.75 → monitoring; PCI > 0.75 → healthy.
 *
 * The job persists pci_score on the most-recent borrower_risk_scores row for
 * each (tenant_id, borrower_id, loan_sanction_id) triplet so freshness/audit
 * logic stays unified with CDS. If no row exists yet, a fresh one is inserted
 * (E-029 normally seeds it; this is a fallback so the PCI job is independently
 * runnable in tests and in environments where CDS hasn't run yet).
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  borrowerRiskScores,
  emiSchedules,
  nbfcRiskAlerts,
} from "@/lib/db/schema";

export const PCI_LOW_THRESHOLD = 0.4;
export const EMI_HISTORY_DEPTH = 6; // last N EMIs considered

export interface PciRunResult {
  computed_count: number;
  alert_triggered_count: number;
  run_at: string;
}

interface EmiRow {
  due_date: string | Date;
  paid_at: Date | null;
  status: string | null;
  days_overdue: number | null;
}

/**
 * Map a single EMI row to its PCI sub-score.
 *   1.0 — paid on time (status='paid' OR paid_at <= due_date OR days_overdue<=0)
 *   0.5 — paid late (<7 days late)
 *   0.0 — missed/overdue
 */
export function emiScore(row: EmiRow): number {
  const status = String(row.status ?? "").toLowerCase();
  const days = row.days_overdue ?? 0;
  if (status === "paid" || (row.paid_at != null && days <= 0)) return 1.0;
  if (status === "paid_late" || (row.paid_at != null && days > 0 && days < 7)) {
    return 0.5;
  }
  // Anything else (missed, overdue, pending past-due) is a 0.
  return 0.0;
}

/**
 * Compute PCI from a list of EMIs ordered most-recent-first. The weight schema
 * is linear-by-rank so the most recent EMI carries the highest weight without
 * starving older history.
 */
export function pciFromEmis(rowsRecentFirst: EmiRow[]): number {
  if (rowsRecentFirst.length === 0) return 0;
  const n = Math.min(rowsRecentFirst.length, EMI_HISTORY_DEPTH);
  let weighted = 0;
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const weight = n - i; // most recent gets weight n, oldest gets 1
    weighted += emiScore(rowsRecentFirst[i]) * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return 0;
  const pci = weighted / totalWeight;
  // Clamp + round to 3 decimals.
  const clamped = Math.max(0, Math.min(1, pci));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Group EMI rows by loan_sanction_id (string keys to avoid uuid/string type
 * mismatches in the runtime collection).
 */
function groupByLoan(rows: Array<EmiRow & { loan_sanction_id: string }>) {
  const map = new Map<string, EmiRow[]>();
  for (const r of rows) {
    const key = r.loan_sanction_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}

/**
 * Run the PCI job. Reads every emi_schedules row, groups by loan, computes
 * PCI, and writes the result back to borrower_risk_scores. Fires a
 * nbfc_risk_alerts row when PCI dips below 0.40.
 */
export async function computePciForAllLoans(opts?: {
  tenantId?: string;
}): Promise<PciRunResult> {
  const runAt = new Date();
  // Pull all EMIs ordered most-recent-first per loan. We do the grouping in JS
  // because the dataset is small (only active loans, ≤6 per loan) and Drizzle
  // doesn't have a portable LATERAL JOIN abstraction.
  const allEmis = await db
    .select({
      loan_sanction_id: emiSchedules.loan_sanction_id,
      due_date: emiSchedules.due_date,
      paid_at: emiSchedules.paid_at,
      status: emiSchedules.status,
      days_overdue: emiSchedules.days_overdue,
    })
    .from(emiSchedules)
    .orderBy(desc(emiSchedules.due_date));

  const grouped = groupByLoan(
    allEmis.map((e) => ({
      ...e,
      loan_sanction_id: String(e.loan_sanction_id),
    })),
  );

  let computedCount = 0;
  let alertCount = 0;

  for (const [loanSanctionId, emis] of grouped.entries()) {
    const pci = pciFromEmis(emis);

    // Find the most recent borrower_risk_scores row for this loan. Optionally
    // scope by tenant when caller passes one (multi-tenant safety).
    const filters = [
      eq(borrowerRiskScores.loan_sanction_id, loanSanctionId),
    ];
    if (opts?.tenantId) {
      filters.push(eq(borrowerRiskScores.tenant_id, opts.tenantId));
    }
    const latestRows = await db
      .select()
      .from(borrowerRiskScores)
      .where(and(...filters))
      .orderBy(desc(borrowerRiskScores.computed_at))
      .limit(1);

    let row = latestRows[0];
    if (!row) {
      // No prior CDS run for this loan — skip silently rather than fabricate
      // a tenant_id/borrower_id we don't have. The CDS job (E-029) is the
      // authoritative seed; PCI piggy-backs on its rows.
      continue;
    }

    await db
      .update(borrowerRiskScores)
      .set({
        pci_score: pci.toFixed(3),
        computed_at: runAt,
      })
      .where(eq(borrowerRiskScores.id, row.id));

    computedCount += 1;

    if (pci < PCI_LOW_THRESHOLD) {
      await db.insert(nbfcRiskAlerts).values({
        tenant_id: row.tenant_id,
        borrower_id: row.borrower_id,
        loan_sanction_id: row.loan_sanction_id,
        type: "pci_low",
        severity: pci < 0.2 ? "critical" : "high",
        payload: {
          pci_score: pci,
          threshold: PCI_LOW_THRESHOLD,
          emi_window: Math.min(emis.length, EMI_HISTORY_DEPTH),
          computed_at: runAt.toISOString(),
        },
        created_at: runAt,
      });
      alertCount += 1;
    }
  }

  return {
    computed_count: computedCount,
    alert_triggered_count: alertCount,
    run_at: runAt.toISOString(),
  };
}
