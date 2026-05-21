/**
 * Seed 50 nbfc_loans rows for apoorvgupta.dce@gmail.com on tenant nbfc-lm2qdk8y.
 *
 * Run:  tsx scripts/seed-nbfc-loans-for-apoorv.ts
 *
 * Idempotent. Safe to re-run — uses ON CONFLICT on the synthetic
 * loan_application_id keys 'BAJAJ-LIVE-0001'..'BAJAJ-LIVE-0050'.
 *
 * What it does (sandbox-only):
 *   1. Resolves apoorvgupta.dce@gmail.com -> users.id
 *   2. Resolves nbfc-lm2qdk8y -> nbfc_tenants.id
 *   3. Deletes the user's other nbfc_users memberships (prints them first
 *      so you can restore if needed). Without this, getCurrentTenant's
 *      first-membership-wins query may pick a different tenant.
 *   4. Pulls 50 vehiclenos from VPS vehicle_state (last_gps_at within 7 days).
 *   5. Generates a 70/20/10 DPD spread + realistic EMI / outstanding amounts.
 *   6. Upserts 50 rows into nbfc_loans, all tagged with the target tenant_id.
 *   7. Updates nbfc_tenants.active_loans on the target tenant.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  borrowerRiskScores,
  leads,
  loanApplications,
  loanSanctions,
  nbfcLoans,
  nbfcRecoveryPipeline,
  nbfcTenants,
  nbfcUsers,
  telemetryIngestionLog,
  users,
} from "@/lib/db/schema";
import { getIotSql } from "@/lib/db/iot";
import { and, eq, ne, sql } from "drizzle-orm";

const USER_EMAIL = "apoorvgupta.dce@gmail.com";
const TARGET_SLUG = "nbfc-lm2qdk8y";
const ID_PREFIX = "BAJAJ-LIVE-";
const ROW_COUNT = 50;

function pickDpdSpread(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 35; i++) out.push(0);
  for (let i = 0; i < 10; i++) out.push(1 + Math.floor(Math.random() * 15));
  for (let i = 0; i < 5; i++) out.push(16 + Math.floor(Math.random() * 45));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function randomEmi(): number {
  return Math.round((4000 + Math.random() * 5000) / 100) * 100;
}

function randomOutstanding(): number {
  return Math.round((50000 + Math.random() * 250000) / 100) * 100;
}

async function main() {
  console.log(`Seeding 50 nbfc_loans for ${USER_EMAIL} on ${TARGET_SLUG}…\n`);

  const userRow = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, USER_EMAIL))
    .limit(1);
  if (!userRow[0]) throw new Error(`User ${USER_EMAIL} not found in users.`);
  const userId = userRow[0].id;
  console.log(`  user_id:   ${userId}`);

  const tenantRow = await db
    .select({ id: nbfcTenants.id, display_name: nbfcTenants.display_name })
    .from(nbfcTenants)
    .where(and(eq(nbfcTenants.slug, TARGET_SLUG), eq(nbfcTenants.is_active, true)))
    .limit(1);
  if (!tenantRow[0]) throw new Error(`Tenant slug ${TARGET_SLUG} not found or not active.`);
  const tenantId = tenantRow[0].id;
  console.log(`  tenant_id: ${tenantId}  (${tenantRow[0].display_name})\n`);

  const stale = await db
    .select({
      user_id: nbfcUsers.user_id,
      tenant_id: nbfcUsers.tenant_id,
      role: nbfcUsers.role,
    })
    .from(nbfcUsers)
    .where(and(eq(nbfcUsers.user_id, userId), ne(nbfcUsers.tenant_id, tenantId)));

  if (stale.length > 0) {
    console.log(`  Removing ${stale.length} other nbfc_users memberships:`);
    for (const s of stale) {
      console.log(`    user_id=${s.user_id}  tenant_id=${s.tenant_id}  role=${s.role}`);
    }
    await db
      .delete(nbfcUsers)
      .where(and(eq(nbfcUsers.user_id, userId), ne(nbfcUsers.tenant_id, tenantId)));
    console.log("  (saved above for reversal — re-INSERT into nbfc_users to restore)\n");
  } else {
    console.log("  No other memberships to remove.\n");
  }

  console.log(`  Pulling 50 reporting vehiclenos from VPS…`);
  const iotSql = getIotSql();
  const vehicles = await iotSql<Array<{ vehicleno: string }>>`
    SELECT vehicleno
    FROM   vehicle_state
    WHERE  last_gps_at >= NOW() - INTERVAL '7 days'
    ORDER  BY last_gps_at DESC
    LIMIT  ${ROW_COUNT}
  `;
  if (vehicles.length < ROW_COUNT) {
    throw new Error(`VPS only returned ${vehicles.length} vehicles, need ${ROW_COUNT}.`);
  }
  console.log(`  got ${vehicles.length} vehiclenos.\n`);

  const leadRow = await db.select({ id: leads.id }).from(leads).limit(1);
  if (!leadRow[0]) throw new Error("No rows in leads — cannot satisfy loan_applications.lead_id FK.");
  const leadId = leadRow[0].id;
  console.log(`  Using lead_id ${leadId} for placeholder loan_applications.\n`);

  console.log(`  Upserting 50 loan_applications placeholders…`);
  for (let i = 0; i < ROW_COUNT; i++) {
    const id = `${ID_PREFIX}${String(i + 1).padStart(4, "0")}`;
    await db
      .insert(loanApplications)
      .values({
        id,
        lead_id: leadId,
        applicant_name: `Bajaj Live Borrower ${i + 1}`,
        nbfc_name: "Bajaj Finance Limited",
        status: "disbursed",
        application_status: "approved",
      })
      .onConflictDoNothing({ target: loanApplications.id });
  }

  const dpdSpread = pickDpdSpread();
  const rows = vehicles.map((v, i) => ({
    loan_application_id: `${ID_PREFIX}${String(i + 1).padStart(4, "0")}`,
    tenant_id: tenantId,
    vehicleno: v.vehicleno,
    emi_amount: String(randomEmi()),
    emi_due_date_dom: 5,
    current_dpd: dpdSpread[i]!,
    outstanding_amount: String(randomOutstanding()),
    is_active: true,
  }));

  console.log(`  Upserting ${rows.length} nbfc_loans rows…`);
  for (const r of rows) {
    await db
      .insert(nbfcLoans)
      .values(r)
      .onConflictDoUpdate({
        target: nbfcLoans.loan_application_id,
        set: {
          tenant_id: r.tenant_id,
          vehicleno: r.vehicleno,
          emi_amount: r.emi_amount,
          emi_due_date_dom: r.emi_due_date_dom,
          current_dpd: r.current_dpd,
          outstanding_amount: r.outstanding_amount,
          is_active: true,
          updated_at: new Date(),
        },
      });
  }

  await db
    .update(nbfcTenants)
    .set({ active_loans: rows.length, updated_at: new Date() })
    .where(eq(nbfcTenants.id, tenantId));

  // ---------------------------------------------------------------------------
  // Portfolio Overview seeding (E-026 / E-027 / E-035)
  //
  // The /nbfc/portfolio cards read from loan_sanctions (Cards 1-3 + 4 unblock),
  // borrower_risk_scores (Card 5 + freshness), nbfc_recovery_pipeline (Card 6),
  // and telemetry_ingestion_log (freshness banner). Without these inserts the
  // 50 nbfc_loans rows above light up only the sidebar count and the
  // batteries drawer.
  // ---------------------------------------------------------------------------

  // 50 loan_sanctions — IDs match BAJAJ-LIVE-XXXX so loan_applications +
  // loan_sanctions stay aligned. ~⅓ disbursed in the current calendar month
  // (UTC; the cards use IST month-start, this still lands in the bucket
  // for any time after the 1st of the month).
  const monthStartUTC = (() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  })();

  const sanctionRows = rows.map((r, i) => {
    const loanAmt = Math.round((Number(r.outstanding_amount) * 1.2) / 100) * 100;
    const inThisMonth = i % 3 === 0;
    const disbursedAt = inThisMonth
      ? new Date(monthStartUTC.getTime() + i * 3_600_000)
      : new Date(monthStartUTC.getTime() - (30 + i) * 86_400_000);
    return {
      id: r.loan_application_id, // shared key with loan_applications
      lead_id: leadId,
      nbfc_id: tenantId,
      loan_amount: String(loanAmt),
      disbursement_amount: String(loanAmt),
      status: "disbursed",
      disbursed_at: disbursedAt,
      closed_at: null as Date | null,
      sanctioned_at: new Date(disbursedAt.getTime() - 86_400_000),
    };
  });

  console.log(`  Upserting ${sanctionRows.length} loan_sanctions rows…`);
  for (const s of sanctionRows) {
    await db
      .insert(loanSanctions)
      .values(s)
      .onConflictDoUpdate({
        target: loanSanctions.id,
        set: {
          nbfc_id: s.nbfc_id,
          status: s.status,
          disbursed_at: s.disbursed_at,
          loan_amount: s.loan_amount,
          disbursement_amount: s.disbursement_amount,
          closed_at: null,
          updated_at: new Date(),
        },
      });
  }

  // borrower_risk_scores — 20 rows, recent computed_at so the freshness check
  // passes. Cards-side query just averages cds_score per tenant; no joins to
  // loan_sanctions, so synthetic UUIDs for borrower_id / loan_sanction_id are
  // fine for the demo.
  const [{ count: cdsCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(borrowerRiskScores)
    .where(eq(borrowerRiskScores.tenant_id, tenantId));
  if (cdsCount === 0) {
    const cdsRows = Array.from({ length: 20 }, () => ({
      tenant_id: tenantId,
      borrower_id: randomUUID(),
      loan_sanction_id: randomUUID(),
      cds_score: String(600 + Math.floor(Math.random() * 200)),
      confidence: "0.85",
      computed_at: new Date(),
    }));
    console.log(`  Inserting ${cdsRows.length} borrower_risk_scores rows…`);
    await db.insert(borrowerRiskScores).values(cdsRows);
  } else {
    console.log(`  Skipping borrower_risk_scores — ${cdsCount} row(s) already present for this tenant.`);
  }

  // nbfc_recovery_pipeline — 5 rows in non-resold stages so Card 6 lights up.
  const [{ count: recoveryCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(nbfcRecoveryPipeline)
    .where(eq(nbfcRecoveryPipeline.tenant_id, tenantId));
  if (recoveryCount === 0) {
    const recoveryRows = Array.from({ length: 5 }, (_, i) => ({
      tenant_id: tenantId,
      battery_serial: `SEED-RECOVERY-${i + 1}`,
      stage: "needs_inspection",
      estimated_recovery_value: String(50_000 + i * 30_000),
    }));
    console.log(`  Inserting ${recoveryRows.length} nbfc_recovery_pipeline rows…`);
    await db.insert(nbfcRecoveryPipeline).values(recoveryRows);
  } else {
    console.log(`  Skipping nbfc_recovery_pipeline — ${recoveryCount} row(s) already present.`);
  }

  // telemetry_ingestion_log — single recent row clears the second half of the
  // "Data may be outdated — IoT sync issue" banner.
  const [{ count: telemetryCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(telemetryIngestionLog)
    .where(eq(telemetryIngestionLog.tenant_id, tenantId));
  if (telemetryCount === 0) {
    console.log("  Inserting 1 telemetry_ingestion_log row…");
    await db.insert(telemetryIngestionLog).values({
      tenant_id: tenantId,
      battery_serial: "SEED-TELEMETRY",
      ingested_at: new Date(),
    });
  } else {
    console.log(`  Skipping telemetry_ingestion_log — ${telemetryCount} row(s) already present.`);
  }

  const sample = rows.slice(0, 5).map((r) => ({
    loan: r.loan_application_id,
    vno: r.vehicleno,
    dpd: r.current_dpd,
    emi: r.emi_amount,
    out: r.outstanding_amount,
  }));
  console.log(`\n  Sample of inserted rows:`);
  console.table(sample);

  console.log("\nDone.");
  console.log(`  Log in as ${USER_EMAIL} ->`);
  console.log(`     /nbfc/portfolio  (six KPI cards + freshness banner cleared)`);
  console.log(`     /nbfc/batteries  (50 rows)`);
  console.log(`     /nbfc/risk       (~5 cards)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
