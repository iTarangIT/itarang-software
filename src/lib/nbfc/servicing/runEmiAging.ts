/**
 * runEmiAging — age the EMI ledger and unify DPD.
 *
 * Replaces the old loan_payments-based DPD heuristic. Source of truth for both
 * the EMI status lifecycle and nbfc_loans.current_dpd is now emi_schedules, so
 * the two ledgers no longer drift.
 *
 * Sweeps (all keyed off the server's CURRENT_DATE — UTC on Vercel cron):
 *   1. scheduled → overdue once due_date has passed; stamp days_overdue.
 *   2. recompute days_overdue for every still-overdue row.
 *   3. overdue → missed past EMI_MISSED_DPD_THRESHOLD days (default 90, ~NPA).
 *   4. nbfc_loans.current_dpd = age of the MOST RECENT overdue/missed
 *      installment (today − latest such due_date), clamped [0, 720]; 0 when
 *      none remain. Uses the MOST RECENT (not oldest) so a long-passed missed
 *      EMI doesn't inflate DPD, and the same {overdue,missed} set as the EMI
 *      Tracker's "Overdue" badge so an Overdue loan always shows a DPD.
 *
 * Used by the daily cron (/api/cron/nbfc/run-emi-aging) and the manual
 * /api/nbfc/loans/refresh-dpd trigger.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emiSchedules, nbfcLoans } from "@/lib/db/schema";

export const EMI_MISSED_DPD_THRESHOLD = Number(
  process.env.EMI_MISSED_DPD_THRESHOLD ?? 90,
);

function rowsAffected(result: unknown): number {
  // postgres-js (our driver) puts affected-row count on `.count`; an UPDATE
  // without RETURNING has 0 *returned* rows, so `.rows.length` reads 0. Prefer
  // `.count`, then fall back to the node-postgres shape (`.rowCount`).
  const r = result as { count?: number; rowCount?: number; rows?: unknown[] };
  return r.count ?? r.rowCount ?? r.rows?.length ?? 0;
}

export interface EmiAgingResult {
  aged_to_overdue: number;
  marked_missed: number;
  dpd_updated: number;
  dpd_cleared: number;
  missed_threshold: number;
}

export async function runEmiAging(): Promise<EmiAgingResult> {
  // 1. scheduled → overdue (past due) + stamp days_overdue.
  const aged = await db.execute(sql`
    UPDATE ${emiSchedules}
    SET status = 'overdue',
        days_overdue = GREATEST(0, (CURRENT_DATE - due_date))
    WHERE status = 'scheduled'
      AND due_date < CURRENT_DATE
  `);

  // 2. Refresh days_overdue for every currently-overdue row.
  await db.execute(sql`
    UPDATE ${emiSchedules}
    SET days_overdue = GREATEST(0, (CURRENT_DATE - due_date))
    WHERE status = 'overdue'
  `);

  // 3. overdue → missed past the threshold.
  const missed = await db.execute(sql`
    UPDATE ${emiSchedules}
    SET status = 'missed'
    WHERE status = 'overdue'
      AND (CURRENT_DATE - due_date) > ${EMI_MISSED_DPD_THRESHOLD}
  `);

  // 4a. current_dpd = age of the MOST RECENT overdue/missed installment
  //     (today − latest such due_date), clamped, per loan. MIN age = latest
  //     due_date. Driven by the SAME {overdue,missed} set as the EMI Tracker's
  //     "Overdue" status badge, so a loan flagged Overdue always shows a DPD —
  //     the two columns can't disagree.
  const dpdUpdated = await db.execute(sql`
    WITH dpd AS (
      SELECT loan_sanction_id,
             COALESCE(MIN(GREATEST(0, (CURRENT_DATE - due_date))), 0) AS dpd
      FROM ${emiSchedules}
      WHERE status IN ('overdue', 'missed')
      GROUP BY loan_sanction_id
    )
    UPDATE ${nbfcLoans} nl
    SET current_dpd = LEAST(720, dpd.dpd),
        updated_at  = NOW()
    FROM dpd
    WHERE nl.loan_application_id = dpd.loan_sanction_id
      AND nl.current_dpd IS DISTINCT FROM LEAST(720, dpd.dpd)
  `);

  // 4b. Clear DPD on loans with no overdue/missed installments left (same set as
  //     4a — a loan with no overdue/missed rows reads as current, DPD 0).
  const dpdCleared = await db.execute(sql`
    UPDATE ${nbfcLoans} nl
    SET current_dpd = 0,
        updated_at  = NOW()
    WHERE nl.current_dpd <> 0
      AND NOT EXISTS (
        SELECT 1 FROM ${emiSchedules} es
        WHERE es.loan_sanction_id = nl.loan_application_id
          AND es.status IN ('overdue', 'missed')
      )
  `);

  return {
    aged_to_overdue: rowsAffected(aged),
    marked_missed: rowsAffected(missed),
    dpd_updated: rowsAffected(dpdUpdated),
    dpd_cleared: rowsAffected(dpdCleared),
    missed_threshold: EMI_MISSED_DPD_THRESHOLD,
  };
}
