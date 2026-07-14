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
import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  borrowerRiskScores,
  emiSchedules,
  nbfcRiskAlerts,
} from "@/lib/db/schema";
import { loadRiskThresholds } from "@/lib/nbfc/risk-thresholds";

/**
 * Fallback for the `pci_concern` rule in `nbfc_risk_rules` (BRD default 0.40).
 *
 * Prefer `loadRiskThresholds().pci_concern` — the governed value, changeable
 * through the admin Risk Rule screen behind the two-person approval gate. This
 * constant is only the default used when that row cannot be read, and the value
 * `computePciBreakdown` assumes when no caller passes one.
 */
export const PCI_LOW_THRESHOLD = 0.4;
export const PCI_HEALTHY_THRESHOLD = 0.75;
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

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Per-EMI line of the PCI math, in display order (newest first). */
export type PciEmiBreakdown = {
  position: number; // 0 = newest
  status: string | null;
  days_overdue: number | null;
  emi_score: number; // 1.0 on time / 0.5 late / 0.0 missed
  weight: number; // n - position (newest carries the most)
  weighted: number; // emi_score × weight
  contribution: number; // weighted ÷ total_weight (sums to pci_score)
};

/**
 * Every intermediate term behind a PCI number — the single source of truth for
 * both the nightly job (which only needs the final score) and the
 * explainability surface (which needs the whole derivation). Mirrors
 * `CdsBreakdown`; keeping the math here means the drawer can never drift from
 * the score it explains.
 */
export type PciBreakdown = {
  per_emi: PciEmiBreakdown[];
  emi_count: number; // n, the EMIs in the window (≤ EMI_HISTORY_DEPTH)
  weighted_sum: number; // Σ (emi_score × weight)
  total_weight: number; // Σ weight = n(n+1)/2
  raw_score: number; // weighted_sum ÷ total_weight, pre-clamp
  pci_score: number; // clamped 0..1, rounded to 3 decimals
  band: "healthy" | "monitoring" | "high_concern";
};

/**
 * Compute the full PCI derivation for a single loan from EMIs ordered
 * most-recent-first. The weight schema is linear-by-rank so the most recent
 * EMI carries the highest weight without starving older history.
 */
export function computePciBreakdown(
  rowsRecentFirst: EmiRow[],
  /** Governed `pci_concern` rule. Defaults to the BRD value when not supplied. */
  lowThreshold: number = PCI_LOW_THRESHOLD,
): PciBreakdown {
  const window = rowsRecentFirst.slice(0, EMI_HISTORY_DEPTH);
  const n = window.length;
  const total_weight = (n * (n + 1)) / 2;

  const per_emi: PciEmiBreakdown[] = [];
  let weighted_sum = 0;
  window.forEach((row, idx) => {
    const score = emiScore(row);
    const weight = n - idx; // most recent gets weight n, oldest gets 1
    const weighted = score * weight;
    weighted_sum += weighted;
    per_emi.push({
      position: idx,
      status: row.status ?? null,
      days_overdue: row.days_overdue ?? null,
      emi_score: score,
      weight,
      weighted: round3(weighted),
      contribution: total_weight > 0 ? round3(weighted / total_weight) : 0,
    });
  });

  const raw = total_weight > 0 ? weighted_sum / total_weight : 0;
  const pci_score = round3(Math.max(0, Math.min(1, raw)));

  return {
    per_emi,
    emi_count: n,
    weighted_sum: round3(weighted_sum),
    total_weight,
    raw_score: round3(raw),
    pci_score,
    band:
      pci_score < lowThreshold
        ? "high_concern"
        : pci_score > PCI_HEALTHY_THRESHOLD
          ? "healthy"
          : "monitoring",
  };
}

/**
 * Compute PCI from a list of EMIs ordered most-recent-first. Thin wrapper over
 * `computePciBreakdown` so the score and its explanation are produced by the
 * exact same arithmetic.
 */
export function pciFromEmis(rowsRecentFirst: EmiRow[]): number {
  if (rowsRecentFirst.length === 0) return 0;
  return computePciBreakdown(rowsRecentFirst).pci_score;
}

/**
 * Plain-language reference for the PCI inputs — surfaced in the explainability
 * drawer so an NBFC partner unfamiliar with the fields can read the rules
 * behind each number. Mirrors CDS_EMI_WEIGHT_RULES.
 */
export const PCI_EMI_SCORE_RULES: {
  label: string;
  condition: string;
  score: number;
}[] = [
  {
    label: "Paid on time",
    condition: "status = paid, or paid on/before the due date",
    score: 1.0,
  },
  {
    label: "Paid late (< 7 days)",
    condition: "status = paid_late, or paid 1–6 days after the due date",
    score: 0.5,
  },
  {
    label: "Missed / overdue",
    condition: "anything else — missed, overdue, still unpaid past due",
    score: 0.0,
  },
];

export const PCI_WEIGHT_RULE = `The newest elapsed EMI carries weight n, the next n−1, down to 1 for the oldest — where n is the number of EMIs in the window (at most ${EMI_HISTORY_DEPTH}). Weights are normalised by their sum, n(n+1)÷2.`;

export const PCI_BAND_RULE = `PCI above ${PCI_HEALTHY_THRESHOLD} is healthy; ${PCI_LOW_THRESHOLD}–${PCI_HEALTHY_THRESHOLD} is monitoring; below ${PCI_LOW_THRESHOLD} is high concern and fires a pci_low risk alert.`;

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
 * nbfc_risk_alerts row when PCI dips below the governed `pci_concern` rule.
 */
export async function computePciForAllLoans(opts?: {
  tenantId?: string;
}): Promise<PciRunResult> {
  const runAt = new Date();
  // The governed concern threshold, resolved once for the whole run. Previously
  // hard-coded to 0.40, which meant the admin Risk Rule screen's `pci_concern`
  // value was decorative.
  const { pci_concern: lowThreshold } = await loadRiskThresholds();
  // Pull the ELAPSED EMIs (due on/before today) ordered most-recent-first per
  // loan. We do the grouping in JS because the dataset is small (only active
  // loans, ≤6 per loan) and Drizzle doesn't have a portable LATERAL JOIN
  // abstraction.
  //
  // The `due_date <= today` filter is load-bearing: without it the newest-first
  // ordering puts the furthest-FUTURE installments first, all status='scheduled'
  // and therefore emiScore 0, so every loan scored a flat PCI of 0.000. Matches
  // the window used by liveScores.ts and the explainability route.
  const today = runAt.toISOString().slice(0, 10);
  const allEmis = await db
    .select({
      loan_sanction_id: emiSchedules.loan_sanction_id,
      due_date: emiSchedules.due_date,
      paid_at: emiSchedules.paid_at,
      status: emiSchedules.status,
      days_overdue: emiSchedules.days_overdue,
    })
    .from(emiSchedules)
    .where(lte(emiSchedules.due_date, today))
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

    const row = latestRows[0];
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

    if (pci < lowThreshold) {
      await db.insert(nbfcRiskAlerts).values({
        tenant_id: row.tenant_id,
        borrower_id: row.borrower_id,
        loan_sanction_id: row.loan_sanction_id,
        type: "pci_low",
        // Half the concern threshold is the "critical" mark, so this tracks the
        // governed value instead of staying pinned at a hard-coded 0.2.
        severity: pci < lowThreshold / 2 ? "critical" : "high",
        payload: {
          pci_score: pci,
          threshold: lowThreshold,
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
