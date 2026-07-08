/**
 * recomputeLoanDpd — refresh nbfc_loans.current_dpd for ONE loan from its
 * emi_schedules, synchronously, inside the caller's transaction.
 *
 * DPD is a STORED column on nbfc_loans, read by every downstream surface (the
 * EMI Tracker DPD column, Lead Intelligence's DPD column + its dpd>0→overdue
 * status flip + DPD filter, and Battery Monitoring's EMI on-time/overdue
 * filter). Portfolio-wide it is owned by runEmiAging (the daily cron /
 * refresh-dpd trigger). But a manual EMI edit or a partial collection changes
 * the emi_schedules window for a single loan WITHOUT closing it, and neither
 * write path re-ages DPD — so the DPD shown across all three views would lag the
 * edit until the next nightly sweep.
 *
 * This helper closes that gap: it applies runEmiAging's DPD formula (step 4)
 * scoped to the one loan the operator just touched, so the DPD everywhere tracks
 * the edit on the next render.
 *
 * Formula (identical to runEmiAging §4a/4b):
 *   current_dpd = age of the MOST RECENT overdue/missed installment
 *   (CURRENT_DATE − latest such due_date), clamped [0, 720]; 0 when the loan has
 *   no overdue/missed installments left. Driven by the SAME {overdue,missed} set
 *   as the EMI Tracker's Overdue badge, so the DPD and status columns can't
 *   disagree.
 *
 * Does NOT age scheduled→overdue or overdue→missed (that is date-driven and
 * stays with runEmiAging); it only re-derives the aggregate DPD from whatever
 * states the installments are already in. Closing a loan is still owned by
 * applyEmiPayment (which zeroes DPD directly), so this is a no-op there.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emiSchedules, nbfcLoans } from "@/lib/db/schema";

/** A live db handle OR an open transaction — same shape for our writes. */
type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Recompute and persist current_dpd for a single loan. Safe to call inside a
 * transaction. The IS DISTINCT guard makes it a no-op when the value is already
 * correct.
 */
export async function recomputeLoanDpd(
  tx: TxLike,
  loanSanctionId: string,
): Promise<void> {
  await tx.execute(sql`
    WITH dpd AS (
      SELECT COALESCE(
               MIN(GREATEST(0, (CURRENT_DATE - due_date))), 0
             ) AS dpd
      FROM ${emiSchedules}
      WHERE loan_sanction_id = ${loanSanctionId}
        AND status IN ('overdue', 'missed')
    )
    UPDATE ${nbfcLoans} nl
    SET current_dpd = LEAST(720, (SELECT dpd FROM dpd)),
        updated_at  = NOW()
    WHERE nl.loan_application_id = ${loanSanctionId}
      AND nl.current_dpd IS DISTINCT FROM LEAST(720, (SELECT dpd FROM dpd))
  `);
}
