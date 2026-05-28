/**
 * One-time sandbox data repair for the NBFC portal.
 *
 * The portal tenant nbfc-lm2qdk8y ("Bajaj Finance Limited") has 50 nbfc_loans
 * rows but ZERO loan_sanctions — the servicing ledger was seeded directly, but
 * the origination records were never created. The /nbfc/portfolio cards read
 * loan_sanctions, so the page shows all zeros.
 *
 * This reconstructs the missing origination layer so the data is consistent
 * with the disbursement-bridge architecture:
 *   1. Derive a loan_sanctions row (status='disbursed') from each nbfc_loans row.
 *   2. Run projectDisbursedLoan() per loan -> generates emi_schedules.
 *   3. Demo-seed borrower_risk_scores / telemetry_ingestion_log /
 *      nbfc_recovery_pipeline so the CDS card + freshness badge populate.
 *
 * Additive + idempotent. No deletes. Scoped to one tenant.
 *
 * Run:  tsx scripts/repair-nbfc-portfolio-data.ts [tenant-slug]
 *       (defaults to nbfc-lm2qdk8y)
 */
import "./_load-env";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  borrowerRiskScores,
  leads,
  loanSanctions,
  nbfcLoans,
  nbfcRecoveryPipeline,
  nbfcTenants,
  telemetryIngestionLog,
} from "@/lib/db/schema";
import { projectDisbursedLoan } from "@/lib/nbfc/servicing/projectDisbursedLoan";

const TARGET_SLUG = process.argv[2] ?? "nbfc-lm2qdk8y";

async function count(table: typeof borrowerRiskScores | typeof telemetryIngestionLog | typeof nbfcRecoveryPipeline, tenantId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.tenant_id, tenantId));
  return n;
}

async function main() {
  const [tenant] = await db
    .select({ id: nbfcTenants.id, display_name: nbfcTenants.display_name })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.slug, TARGET_SLUG))
    .limit(1);
  if (!tenant) throw new Error(`Tenant slug '${TARGET_SLUG}' not found.`);
  console.log(`Tenant: ${tenant.display_name} (${TARGET_SLUG})  ${tenant.id}\n`);

  const loans = await db
    .select()
    .from(nbfcLoans)
    .where(eq(nbfcLoans.tenant_id, tenant.id));
  console.log(`  ${loans.length} nbfc_loans rows found.`);
  if (loans.length === 0) {
    console.log("  Nothing to repair.");
    process.exit(0);
  }

  // Bind each loan to a distinct real lead so Lead Intelligence shows distinct
  // borrowers. Reuses existing CRM leads (cyclically if fewer than loans) — a
  // display join only; the leads themselves are never modified.
  const leadRows = await db
    .select({ id: leads.id })
    .from(leads)
    .orderBy(leads.id)
    .limit(Math.max(loans.length, 1));
  if (leadRows.length === 0) {
    throw new Error("No rows in `leads` — cannot satisfy loan_sanctions.lead_id.");
  }

  const now = new Date();
  const monthStartUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // 1. Reconstruct loan_sanctions (origination records) from nbfc_loans.
  console.log("  Upserting loan_sanctions…");
  for (let i = 0; i < loans.length; i++) {
    const l = loans[i]!;
    const outstanding = l.outstanding_amount != null ? Number(l.outstanding_amount) : 120_000;
    const loanAmt = Math.round((outstanding * 1.15) / 100) * 100;
    const inThisMonth = i % 3 === 0;
    const disbursedAt = inThisMonth
      ? new Date(monthStartUTC.getTime() + i * 3_600_000)
      : new Date(monthStartUTC.getTime() - (30 + i) * 86_400_000);
    const leadId = leadRows[i % leadRows.length]!.id;
    await db
      .insert(loanSanctions)
      .values({
        id: l.loan_application_id, // 1:1 key with nbfc_loans + the bridge
        lead_id: leadId,
        nbfc_id: tenant.id,
        loan_amount: String(loanAmt),
        down_payment: "0",
        file_charge: "0",
        subvention: "0",
        disbursement_amount: String(loanAmt),
        emi: l.emi_amount ?? "0",
        tenure_months: 24,
        roi: "18.00",
        loan_approved_by: tenant.display_name,
        loan_file_number: `LF-${l.loan_application_id}`.slice(0, 100),
        status: "disbursed",
        disbursed_at: disbursedAt,
        sanctioned_at: new Date(disbursedAt.getTime() - 86_400_000),
        created_at: now,
        updated_at: now,
      })
      // onConflictDoUpdate (not DoNothing) so a re-run rebinds lead_id on rows
      // a previous run created against the placeholder lead.
      .onConflictDoUpdate({
        target: loanSanctions.id,
        set: {
          lead_id: leadId,
          nbfc_id: tenant.id,
          status: "disbursed",
          disbursed_at: disbursedAt,
          updated_at: now,
        },
      });
  }
  console.log(`    ${loans.length} loan_sanctions upserted.`);

  // 2. Run the disbursement bridge per loan -> emi_schedules + active_loans.
  console.log("  Running disbursement bridge (emi_schedules)…");
  for (const l of loans) {
    await db.transaction(async (tx) => {
      await projectDisbursedLoan(tx, l.loan_application_id);
    });
  }
  console.log("    emi_schedules generated.");

  // 3. Demo-seed borrower_risk_scores (CDS card + freshness CDS half).
  if ((await count(borrowerRiskScores, tenant.id)) === 0) {
    await db.insert(borrowerRiskScores).values(
      loans.map(() => ({
        tenant_id: tenant.id,
        borrower_id: randomUUID(),
        loan_sanction_id: randomUUID(),
        cds_score: String(600 + Math.floor(Math.random() * 200)),
        confidence: "0.85",
        computed_at: now,
      })),
    );
    console.log(`  Inserted ${loans.length} borrower_risk_scores.`);
  } else {
    console.log("  borrower_risk_scores already present — skipped.");
  }

  // 4. Demo-seed telemetry_ingestion_log (freshness badge telemetry half).
  if ((await count(telemetryIngestionLog, tenant.id)) === 0) {
    await db.insert(telemetryIngestionLog).values(
      loans.slice(0, 10).map((l) => ({
        tenant_id: tenant.id,
        battery_serial: (l.vehicleno ?? `SEED-${l.loan_application_id}`).slice(0, 64),
        ingested_at: now,
      })),
    );
    console.log("  Inserted telemetry_ingestion_log rows.");
  } else {
    console.log("  telemetry_ingestion_log already present — skipped.");
  }

  // 5. Demo-seed nbfc_recovery_pipeline (Recovery Value Locked card).
  if ((await count(nbfcRecoveryPipeline, tenant.id)) === 0) {
    await db.insert(nbfcRecoveryPipeline).values(
      Array.from({ length: 5 }, (_, i) => ({
        tenant_id: tenant.id,
        battery_serial: `SEED-RECOVERY-${i + 1}`,
        stage: "needs_inspection",
        estimated_recovery_value: String(50_000 + i * 30_000),
      })),
    );
    console.log("  Inserted 5 nbfc_recovery_pipeline rows.");
  } else {
    console.log("  nbfc_recovery_pipeline already present — skipped.");
  }

  console.log("\nDone. Reload /nbfc/portfolio — all seven cards should now populate.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
