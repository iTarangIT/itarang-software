/**
 * Backfill the NBFC servicing ledger for loans that were disbursed before the
 * disbursement bridge existed.
 *
 * Run:  tsx scripts/backfill-nbfc-servicing.ts
 *
 * For every loan_sanctions row with status='disbursed' AND nbfc_id IS NOT NULL,
 * runs projectDisbursedLoan() — idempotently creating its nbfc_loans row and
 * emi_schedules ledger so the NBFC portal (portfolio / batteries / leads /
 * recovery) reflects the real book.
 *
 * Idempotent. Safe to re-run.
 *
 * PREREQUISITE: run scripts/backfill-nbfc-id-on-loan-sanctions.ts FIRST so that
 * loan_sanctions.nbfc_id is stamped on rows whose loan_approved_by matches an
 * NBFC legal name — otherwise those loans are skipped here (nbfc_id IS NULL).
 */
import "./_load-env";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { loanSanctions } from "@/lib/db/schema";
import { projectDisbursedLoan } from "@/lib/nbfc/servicing/projectDisbursedLoan";

async function main() {
  console.log("Backfilling NBFC servicing ledger from disbursed loan_sanctions…\n");

  const loans = await db
    .select({ id: loanSanctions.id, nbfc_id: loanSanctions.nbfc_id })
    .from(loanSanctions)
    .where(
      and(
        eq(loanSanctions.status, "disbursed"),
        isNotNull(loanSanctions.nbfc_id),
      ),
    );

  console.log(`  Found ${loans.length} disbursed NBFC-financed loan(s).\n`);

  let ok = 0;
  let failed = 0;
  for (const loan of loans) {
    try {
      await db.transaction(async (tx) => {
        await projectDisbursedLoan(tx, loan.id);
      });
      ok++;
    } catch (e) {
      failed++;
      console.error(
        `  ✗ ${loan.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  console.log(`\nDone. Projected ${ok} loan(s), ${failed} failed.`);
  console.log(
    "  Next: POST /api/cron/nbfc/compute-cds to populate borrower_risk_scores,",
  );
  console.log("  then open /nbfc/portfolio.");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
