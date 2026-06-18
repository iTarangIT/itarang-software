/**
 * Compute CDS + PCI for the imported LS-IMPORT-* loans using the SAME engine
 * functions the nightly cron uses (computeCdsForLoan / pciFromEmis), then write
 * one borrower_risk_scores row per loan. The cron itself skips these because it
 * only scores UUID loan ids (computeCds.ts:221); we call the pure scorers
 * directly so the readable LS-IMPORT-* ids still get scored.
 *
 * RISK + CONF. columns are derived from CDS/confidence in the UI — no extra
 * write. SOH stays blank (pure VPS battery telemetry, not derivable here).
 *
 * Scoring window: the most recent 6 ELAPSED installments (due on/before today),
 * most-recent-first — i.e. the borrower's actual trailing repayment record.
 *
 * Idempotent: clears prior LS-IMPORT-* risk rows before inserting.
 *
 * Usage: tsx scripts/score-imported-loans.ts
 */
import "./_load-env";
import { and, desc, eq, lte, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { loanSanctions, emiSchedules, borrowerRiskScores } from "@/lib/db/schema";
import { computeCdsForLoan } from "@/lib/nbfc/cds/computeCds";
import { pciFromEmis } from "@/lib/nbfc/pci/computePci";
import { randomUUID } from "node:crypto";

const TENANT_ID = "02bda647-c164-4e81-809b-01cfe159cdb6";
const TODAY = "2026-06-17"; // currentDate; scores the repayment record up to today

async function main() {
  const host = (process.env.DATABASE_URL || "").match(/@([^/:]+)/)?.[1];
  console.log(`DB host: ${host}\n`);

  const loans = await db
    .select({ id: loanSanctions.id, nbfc_id: loanSanctions.nbfc_id })
    .from(loanSanctions)
    .where(and(eq(loanSanctions.nbfc_id, TENANT_ID), like(loanSanctions.id, "LS-IMPORT-%")))
    .orderBy(loanSanctions.id);

  console.log(`Scoring ${loans.length} imported loan(s).\n`);

  // Idempotency: drop prior scores for these loans so we don't stack rows.
  await db.delete(borrowerRiskScores).where(like(borrowerRiskScores.loan_sanction_id, "LS-IMPORT-%"));

  const out: Record<string, unknown>[] = [];
  for (const loan of loans) {
    // Most recent 6 ELAPSED EMIs (due ≤ today), newest first — the trailing
    // repayment record the score is meant to reflect.
    const emis = await db
      .select({
        status: emiSchedules.status,
        days_overdue: emiSchedules.days_overdue,
        due_date: emiSchedules.due_date,
        paid_at: emiSchedules.paid_at,
      })
      .from(emiSchedules)
      .where(and(eq(emiSchedules.loan_sanction_id, loan.id), lte(emiSchedules.due_date, TODAY)))
      .orderBy(desc(emiSchedules.due_date))
      .limit(6);

    const { cds_score, confidence } = computeCdsForLoan({
      emis: emis.map((e) => ({ status: e.status, days_overdue: e.days_overdue })),
      telemetryIngestedAt: null, // no live telemetry → telemetry term 0, confidence capped at MEDIUM
      restructuringFlag: false,
      now: new Date(`${TODAY}T00:00:00Z`),
    });
    const pci_score = pciFromEmis(emis);

    await db.insert(borrowerRiskScores).values({
      tenant_id: TENANT_ID,
      borrower_id: randomUUID(),
      loan_sanction_id: loan.id,
      cds_score: cds_score.toString(),
      pci_score: pci_score.toString(),
      confidence,
      computed_at: new Date(`${TODAY}T00:00:00Z`),
    });

    // RISK band the UI will show (default thresholds 40 / 70 / 85).
    const risk =
      cds_score >= 85 ? "Very High" : cds_score >= 70 ? "High" : cds_score >= 40 ? "Medium" : "Low";
    out.push({ loan: loan.id, emis_used: emis.length, cds: cds_score, pci: pci_score, risk, conf: confidence });
  }

  console.table(out);
  console.log("\nDone. Open /nbfc/batteries — CDS, PCI, RISK and CONF. now populate.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
