/**
 * Disbursement bridge — projects a disbursed `loan_sanctions` row into the
 * NBFC servicing ledger (BRD §6.1.3 / §8.0).
 *
 * The NBFC portal runs on two tables that nothing kept in sync:
 *
 *   - loan_sanctions  — the origination record (admin Step 4 → Step 5 disburse)
 *   - nbfc_loans      — the portal's servicing ledger (batteries / leads /
 *                       recovery pages + sidebar count)
 *
 * Before this bridge, `nbfc_loans` was only ever written by a seed script or
 * the CSV import route, so a real disbursed loan never appeared in the portal.
 * `projectDisbursedLoan` closes that gap: called the moment a loan flips to
 * `status='disbursed'`, it idempotently creates the `nbfc_loans` row, generates
 * the `emi_schedules` ledger (read by the nightly CDS job), and refreshes the
 * tenant's cached active-loan count.
 *
 * Idempotent — safe to re-run (used by scripts/backfill-nbfc-servicing.ts).
 * No-ops cleanly when the loan has no `nbfc_id` (cash sale / unmapped lender),
 * so it can never break the dispatch transaction it runs inside.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  emiSchedules,
  loanSanctions,
  nbfcLoans,
  nbfcTenants,
  productSelections,
} from "@/lib/db/schema";

/** A live db handle OR an open transaction — same shape for our writes. */
type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Add `n` whole months to `d`, clamping the day to the target month's length. */
function addMonthsClamped(d: Date, n: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + n;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDom = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const dom = Math.min(d.getUTCDate(), lastDom);
  return new Date(Date.UTC(targetYear, targetMonth, dom));
}

/** Format a Date as a `YYYY-MM-DD` string for a postgres `date` column. */
function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Project a disbursed loan into the NBFC servicing ledger.
 *
 * @param tx              live db OR an open transaction (run inside the
 *                        disbursement txn so the projection is atomic).
 * @param loanSanctionId  `loan_sanctions.id` of the just-disbursed loan.
 */
export async function projectDisbursedLoan(
  tx: TxLike,
  loanSanctionId: string,
): Promise<void> {
  const [loan] = await tx
    .select()
    .from(loanSanctions)
    .where(eq(loanSanctions.id, loanSanctionId))
    .limit(1);

  if (!loan) {
    console.warn(
      `[projectDisbursedLoan] loan_sanctions ${loanSanctionId} not found — skipped.`,
    );
    return;
  }

  // Cash sale, or a lender that isn't mapped to an NBFC portal tenant yet.
  // Not an error — just nothing to project. Must never throw here, or it
  // would roll back the dispatch transaction.
  if (!loan.nbfc_id) {
    console.warn(
      `[projectDisbursedLoan] loan ${loanSanctionId} has no nbfc_id — not an NBFC-financed loan, skipped.`,
    );
    return;
  }

  // Resolve the financed battery serial. Prefer the product_selection the
  // sanction was tied to; fall back to the latest selection on the lead.
  let batterySerial: string | null = null;
  if (loan.product_selection_id) {
    const [sel] = await tx
      .select({ battery_serial: productSelections.battery_serial })
      .from(productSelections)
      .where(eq(productSelections.id, loan.product_selection_id))
      .limit(1);
    batterySerial = sel?.battery_serial ?? null;
  }
  if (!batterySerial) {
    const [sel] = await tx
      .select({ battery_serial: productSelections.battery_serial })
      .from(productSelections)
      .where(eq(productSelections.lead_id, loan.lead_id))
      .orderBy(desc(productSelections.created_at))
      .limit(1);
    batterySerial = sel?.battery_serial ?? null;
  }

  const disbursedAt = loan.disbursed_at ?? new Date();

  // 1. Servicing ledger row. PK is loan_application_id; we key it to the
  //    loan_sanctions.id so the projection is 1:1 and idempotent.
  await tx
    .insert(nbfcLoans)
    .values({
      loan_application_id: loan.id,
      tenant_id: loan.nbfc_id,
      vehicleno: batterySerial,
      emi_amount: loan.emi ?? null,
      emi_due_date_dom: disbursedAt.getUTCDate(),
      current_dpd: 0,
      outstanding_amount: loan.loan_amount ?? null,
      is_active: true,
    })
    .onConflictDoNothing({ target: nbfcLoans.loan_application_id });

  // 2. EMI schedule — the per-loan ledger the nightly CDS job reads. Guard on
  //    existing rows so a re-run never double-inserts (no natural unique key).
  const tenure = loan.tenure_months ?? 0;
  if (tenure > 0) {
    const [{ count: existing }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, loan.id));

    if (existing === 0) {
      const rows = Array.from({ length: tenure }, (_, i) => ({
        loan_sanction_id: loan.id,
        due_date: toDateString(addMonthsClamped(disbursedAt, i + 1)),
        status: "scheduled",
      }));
      await tx.insert(emiSchedules).values(rows);
    }
  }

  // 3. Refresh the tenant's cached active-loan count from the live ledger.
  const [{ count: activeCount }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(nbfcLoans)
    .where(and(eq(nbfcLoans.tenant_id, loan.nbfc_id), eq(nbfcLoans.is_active, true)));

  await tx
    .update(nbfcTenants)
    .set({ active_loans: activeCount, updated_at: new Date() })
    .where(eq(nbfcTenants.id, loan.nbfc_id));
}
