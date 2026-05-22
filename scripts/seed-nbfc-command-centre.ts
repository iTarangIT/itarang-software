/**
 * Seed realistic demo data for the NBFC Portfolio Command Centre.
 *
 * Run:  tsx scripts/seed-nbfc-command-centre.ts
 *
 * Prereq: scripts/seed-nbfc-loans-for-apoorv.ts has already created the 50
 * BAJAJ-LIVE loans + loan_sanctions for tenant nbfc-lm2qdk8y. This script
 * builds on that — it does NOT create loans.
 *
 * Idempotent. Safe to re-run: leads upsert on synthetic ids; the loan→lead
 * reassignment is a deterministic UPDATE; every other table is guarded by a
 * presence check and skipped on a second run.
 *
 * What it seeds (tenant nbfc-lm2qdk8y only):
 *   1. 50 leads (CMDC-LEAD-XXXX) — distinct borrowers, 6 cities, product model
 *      + dealer — and reassigns each loan_sanctions.lead_id.
 *   2. emi_schedules — 7 EMIs per loan (6 past + 1 upcoming) with a realistic
 *      paid / late / overdue / cured mix; syncs nbfc_loans.current_dpd to it.
 *   3. borrower_risk_scores — 50 CDS/PCI rows keyed to the real loan ids.
 *   4. telemetry_alerts — 18 rows (15 open, 3 resolved) on real vehiclenos.
 *   5. nbfc_risk_alerts — 14 rows keyed to real loan ids (11 open, 3 resolved).
 *   6. nbfc_borrower_actions — 12 governed actions in the last 7 days.
 *   7. nbfc_recovery_pipeline + nbfc_immobilisation_actions — recent rows.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  borrowerRiskScores,
  dealers,
  emiSchedules,
  leads,
  loanSanctions,
  nbfcBorrowerActions,
  nbfcImmobilisationActions,
  nbfcLoans,
  nbfcRecoveryPipeline,
  nbfcRiskAlerts,
  nbfcTenants,
  telemetryAlerts,
} from "@/lib/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

const TARGET_SLUG = "nbfc-lm2qdk8y";
const EXPECTED_TENANT_ID = "f725e9d3-8ccd-4709-9e03-fe5fab8858ff";

const CITIES = ["Pune", "Nagpur", "Nashik", "Aurangabad", "Kolhapur", "Solapur"];
const STATE = "Maharashtra";

// Financed product models — round-robin so the Lead Intelligence Product
// filter has a handful of real options.
const ASSET_MODELS = [
  "iTarang PowerPack 3.5 kWh",
  "iTarang City 2.5 kWh",
  "iTarang Cargo 5.0 kWh",
  "iTarang Lite 1.8 kWh",
  "iTarang Max 7.2 kWh",
];

// 50 distinct borrower names.
const NAMES = [
  "Aarav Sharma", "Vivaan Verma", "Aditya Kumar", "Vihaan Yadav",
  "Arjun Patil", "Reyansh Jadhav", "Sai Pawar", "Krishna Deshmukh",
  "Ishaan Shinde", "Rohan More", "Rahul Gaikwad", "Mohan Kale",
  "Raju Joshi", "Guddu Kulkarni", "Pappu Bhosale", "Santosh Chavan",
  "Feroz Shaikh", "Mukesh Pandey", "Imran Khan", "Suresh Naik",
  "Ramesh Sawant", "Dinesh Thakur", "Naresh Pawar", "Mahesh Jadhav",
  "Ganesh Patil", "Pradeep Sharma", "Sandeep Kumar", "Anil Verma",
  "Sunil Yadav", "Vijay Deshmukh", "Ajay Shinde", "Manoj More",
  "Deepak Kale", "Ashok Joshi", "Vinod Gaikwad", "Prakash Bhosale",
  "Rajesh Chavan", "Sanjay Naik", "Amit Sawant", "Sumit Thakur",
  "Nitin Kulkarni", "Sachin Pandey", "Pankaj Shaikh", "Gopal Khan",
  "Kishore Naik", "Bharat Patil", "Hari Verma", "Shyam Kumar",
  "Madhav Joshi", "Kiran Deshmukh",
];

const DAY = 86_400_000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);
const dateStr = (d: Date): string => d.toISOString().slice(0, 10);

// Loan profile by 0-based index — deterministic, disjoint ranges.
type Profile = "delinquent" | "cured" | "mildlate" | "good";
function profileOf(i: number): Profile {
  if (i < 5) return "delinquent";
  if (i < 8) return "cured";
  if (i < 15) return "mildlate";
  return "good";
}

interface EmiRow {
  loan_sanction_id: string;
  due_date: string;
  paid_at: Date | null;
  status: string;
  days_overdue: number | null;
}

/** 7 EMIs for one loan: 6 past (shaped by profile) + 1 upcoming scheduled. */
function buildEmis(loanId: string, i: number): EmiRow[] {
  const profile = profileOf(i);
  const base =
    profile === "delinquent"
      ? 32
      : profile === "cured"
        ? 8
        : profile === "mildlate"
          ? 14 + (i % 8)
          : 3 + (i % 25);
  const dueDaysAgo = (k: number): number => base + (5 - k) * 30; // k = 0..5
  const rows: EmiRow[] = [];

  for (let k = 0; k < 6; k++) {
    const due = daysAgo(dueDaysAgo(k));
    let status = "paid";
    let paid_at: Date | null = daysAgo(dueDaysAgo(k) - 1);
    let days_overdue: number | null = null;

    if (profile === "delinquent" && (k === 4 || k === 5)) {
      // The two most-recent EMIs are unpaid and well past 30 days.
      status = "overdue";
      paid_at = null;
      days_overdue = dueDaysAgo(k);
    } else if (profile === "cured" && k === 3) {
      // An old EMI that was >30d overdue at month-start, settled this week.
      const paidDaysAgo = 2 + (i % 4);
      status = "paid_late";
      paid_at = daysAgo(paidDaysAgo);
      days_overdue = dueDaysAgo(k) - paidDaysAgo;
    } else if (profile === "mildlate" && k === 5) {
      // Mildly late, settled this week — counts toward weekly EMIs settled.
      const paidDaysAgo = 1 + (i % 6);
      status = "paid_late";
      paid_at = daysAgo(paidDaysAgo);
      days_overdue = dueDaysAgo(k) - paidDaysAgo;
    }

    rows.push({
      loan_sanction_id: loanId,
      due_date: dateStr(due),
      paid_at,
      status,
      days_overdue,
    });
  }

  // The upcoming scheduled instalment (15–30 days out, unpaid) — gives every
  // loan a real "next EMI" date for the Lead Intelligence EMI Status column.
  rows.push({
    loan_sanction_id: loanId,
    due_date: dateStr(daysAgo(-(15 + (i % 16)))),
    paid_at: null,
    status: "scheduled",
    days_overdue: null,
  });
  return rows;
}

async function main() {
  console.log(`Seeding NBFC Command Centre demo data for ${TARGET_SLUG}…\n`);

  // 1. Resolve tenant -----------------------------------------------------
  const [tenant] = await db
    .select({ id: nbfcTenants.id, name: nbfcTenants.display_name })
    .from(nbfcTenants)
    .where(and(eq(nbfcTenants.slug, TARGET_SLUG), eq(nbfcTenants.is_active, true)))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${TARGET_SLUG} not found or inactive.`);
  if (tenant.id !== EXPECTED_TENANT_ID) {
    throw new Error(
      `Tenant id mismatch: expected ${EXPECTED_TENANT_ID}, got ${tenant.id}. Aborting.`,
    );
  }
  const tenantId = tenant.id;
  console.log(`  tenant_id: ${tenantId}  (${tenant.name})`);

  // Load the tenant's loans (stable order for a deterministic loan→lead map).
  const loanRows = await db
    .select({ id: loanSanctions.id })
    .from(loanSanctions)
    .where(eq(loanSanctions.nbfc_id, tenantId))
    .orderBy(loanSanctions.id);
  if (loanRows.length === 0) {
    throw new Error(
      "No loan_sanctions for this tenant. Run scripts/seed-nbfc-loans-for-apoorv.ts first.",
    );
  }
  const loanIds = loanRows.map((r) => r.id);
  console.log(`  loans:     ${loanIds.length}\n`);

  const vnoRows = await db
    .select({ id: nbfcLoans.loan_application_id, vno: nbfcLoans.vehicleno })
    .from(nbfcLoans)
    .where(eq(nbfcLoans.tenant_id, tenantId));
  const vnoByLoan = new Map(vnoRows.map((r) => [r.id, r.vno]));

  // leads.uploader_id is NOT NULL in the live DB (schema.ts drift). Borrow a
  // valid uploader_id from an existing lead so any FK / constraint is met.
  const [uploaderRow] = await db
    .select({ uid: leads.uploader_id })
    .from(leads)
    .where(isNotNull(leads.uploader_id))
    .limit(1);
  if (!uploaderRow?.uid) {
    throw new Error(
      "No existing lead has an uploader_id to borrow — cannot satisfy leads.uploader_id NOT NULL.",
    );
  }
  const uploaderId = uploaderRow.uid;

  // Borrow an existing dealer so the leads table's Dealer column resolves.
  const [dealerRow] = await db
    .select({ id: dealers.dealer_id })
    .from(dealers)
    .limit(1);
  const dealerId = dealerRow?.id ?? null;

  // 2. Leads across 6 cities + loan→lead reassignment ---------------------
  console.log(`  Upserting ${loanIds.length} leads across ${CITIES.length} cities…`);
  for (let i = 0; i < loanIds.length; i++) {
    const leadId = `CMDC-LEAD-${String(i + 1).padStart(4, "0")}`;
    const ownerName = NAMES[i % NAMES.length];
    const leadFields = {
      owner_name: ownerName,
      full_name: ownerName,
      city: CITIES[i % CITIES.length],
      state: STATE,
      asset_model: ASSET_MODELS[i % ASSET_MODELS.length],
      battery_type: "LFP",
      dealer_id: dealerId,
    };
    await db
      .insert(leads)
      .values({
        id: leadId,
        lead_source: "command-centre-seed",
        uploader_id: uploaderId,
        ...leadFields,
      })
      .onConflictDoUpdate({ target: leads.id, set: leadFields });
    await db
      .update(loanSanctions)
      .set({ lead_id: leadId })
      .where(eq(loanSanctions.id, loanIds[i]));
  }
  console.log("  loan_sanctions.lead_id reassigned (deterministic).\n");

  // 3. emi_schedules — replace any forward-only 'scheduled' projection rows
  //    with a realistic paid / late / overdue ledger so delinquency, the MoM
  //    delta and weekly EMIs-settled are meaningful and internally consistent.
  const [{ n: emiExisting }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emiSchedules)
    .where(inArray(emiSchedules.loan_sanction_id, loanIds));
  await db
    .delete(emiSchedules)
    .where(inArray(emiSchedules.loan_sanction_id, loanIds));
  const emiRows = loanIds.flatMap((id, i) => buildEmis(id, i));
  console.log(
    `  emi_schedules: removed ${emiExisting} projection row(s), inserting ${emiRows.length} ledger rows…`,
  );
  for (let c = 0; c < emiRows.length; c += 200) {
    await db.insert(emiSchedules).values(emiRows.slice(c, c + 200));
  }

  // Sync nbfc_loans.current_dpd to the ledger so the Lead Intelligence STATUS
  // and EMI STATUS columns agree (and match the Command Centre delinquency).
  const dpdByLoan = new Map<string, number>();
  for (const e of emiRows) {
    if (
      (e.status === "overdue" || e.status === "missed") &&
      e.days_overdue != null
    ) {
      dpdByLoan.set(
        e.loan_sanction_id,
        Math.max(dpdByLoan.get(e.loan_sanction_id) ?? 0, e.days_overdue),
      );
    }
  }
  for (const id of loanIds) {
    await db
      .update(nbfcLoans)
      .set({ current_dpd: dpdByLoan.get(id) ?? 0 })
      .where(eq(nbfcLoans.loan_application_id, id));
  }
  console.log("  nbfc_loans.current_dpd synced to the emi ledger.");

  // 3b. borrower_risk_scores — replace the tenant's rows with CDS/PCI scores
  //     keyed to the REAL loan ids (post-E-117 the column is varchar). Scores
  //     are 0–100 (BRD §6.1.5) and correlate with each loan's profile.
  await db
    .delete(borrowerRiskScores)
    .where(eq(borrowerRiskScores.tenant_id, tenantId));
  const scoreRows = loanIds.map((id, i) => {
    const profile = profileOf(i);
    const cds =
      profile === "delinquent"
        ? 72 + i * 5 // 72,77,82,87,92 — High / Very High
        : profile === "cured"
          ? 50 + (i % 13) // ~50–62 — Medium
          : profile === "mildlate"
            ? 44 + (i % 22) // ~44–65 — Medium
            : 10 + (i % 33); // ~10–42 — Low
    const pci = Math.min(1, Math.max(0, (100 - cds) / 100));
    const confidence = i % 11 === 4 ? "LOW" : i % 5 === 2 ? "MEDIUM" : "HIGH";
    return {
      tenant_id: tenantId,
      borrower_id: randomUUID(),
      loan_sanction_id: id,
      cds_score: String(cds),
      pci_score: pci.toFixed(3),
      confidence,
      computed_at: daysAgo(0.3),
    };
  });
  console.log(`  Inserting ${scoreRows.length} borrower_risk_scores rows…`);
  await db.insert(borrowerRiskScores).values(scoreRows);

  // 4. telemetry_alerts ---------------------------------------------------
  const vnos = vnoRows.map((r) => r.vno).filter((v): v is string => !!v);
  const [{ n: telCount }] =
    vnos.length === 0
      ? [{ n: 0 }]
      : await db
          .select({ n: sql<number>`count(*)::int` })
          .from(telemetryAlerts)
          .where(inArray(telemetryAlerts.serial_number, vnos));
  if (telCount === 0) {
    type TelSpec = {
      loan: number;
      rule: string;
      severity: string;
      daysAgo: number;
      payload: Record<string, number>;
      resolved?: boolean;
    };
    const specs: TelSpec[] = [
      { loan: 0, rule: "BMS Fault", severity: "critical", daysAgo: 0.2, payload: { temperature_c: 64 } },
      { loan: 1, rule: "Battery Offline Extended", severity: "critical", daysAgo: 1, payload: { offline_hours: 172 } },
      { loan: 2, rule: "Geo-Shift", severity: "critical", daysAgo: 1, payload: { distance_km: 168 } },
      { loan: 5, rule: "Usage Drop", severity: "warning", daysAgo: 0.5, payload: { drop_pct: 43 } },
      { loan: 6, rule: "Low SOC", severity: "warning", daysAgo: 0.3, payload: { soc_percent: 8 } },
      { loan: 8, rule: "High Temperature", severity: "warning", daysAgo: 2, payload: { temperature_c: 58 } },
      { loan: 9, rule: "SOH Decline", severity: "warning", daysAgo: 3, payload: { soh_percent: 71 } },
      { loan: 10, rule: "Battery Offline", severity: "warning", daysAgo: 0.8, payload: { offline_hours: 31 } },
      { loan: 11, rule: "Usage Drop", severity: "warning", daysAgo: 4, payload: { drop_pct: 28 } },
      { loan: 12, rule: "BMS Fault", severity: "critical", daysAgo: 2, payload: { temperature_c: 61 } },
      { loan: 15, rule: "Low SOC", severity: "warning", daysAgo: 5, payload: { soc_percent: 11 } },
      { loan: 16, rule: "Geo-Shift", severity: "critical", daysAgo: 6, payload: { distance_km: 54 } },
      { loan: 18, rule: "SOH Decline", severity: "warning", daysAgo: 1, payload: { soh_percent: 69 } },
      { loan: 20, rule: "High Temperature", severity: "warning", daysAgo: 0.4, payload: { temperature_c: 56 } },
      { loan: 22, rule: "Battery Offline", severity: "info", daysAgo: 2, payload: { offline_hours: 26 } },
      { loan: 3, rule: "Usage Drop", severity: "warning", daysAgo: 9, payload: { drop_pct: 33 }, resolved: true },
      { loan: 7, rule: "Low SOC", severity: "info", daysAgo: 8, payload: { soc_percent: 14 }, resolved: true },
      { loan: 13, rule: "High Temperature", severity: "warning", daysAgo: 10, payload: { temperature_c: 55 }, resolved: true },
    ];
    const telRows = specs
      .map((s) => {
        const vno = vnoByLoan.get(loanIds[s.loan]);
        if (!vno) return null;
        const triggered = daysAgo(s.daysAgo);
        return {
          serial_number: vno,
          rule: s.rule,
          severity: s.severity,
          triggered_at: triggered,
          resolved_at: s.resolved ? daysAgo(s.daysAgo - 1) : null,
          payload: s.payload,
          cds_flagged: s.rule === "Battery Offline Extended",
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    console.log(`  Inserting ${telRows.length} telemetry_alerts rows…`);
    await db.insert(telemetryAlerts).values(telRows);
  } else {
    console.log(`  Skipping telemetry_alerts — ${telCount} row(s) already present.`);
  }

  // 5. nbfc_risk_alerts — keyed to REAL loan ids (post-E-117) so the Command
  //    Centre alert feed resolves borrower names. Replace the tenant's rows.
  await db.delete(nbfcRiskAlerts).where(eq(nbfcRiskAlerts.tenant_id, tenantId));
  {
    type RiskSpec = {
      type: string;
      severity: string;
      daysAgo: number;
      payload: Record<string, number>;
      resolved?: boolean;
    };
    const specs: RiskSpec[] = [
      { type: "cds_high", severity: "critical", daysAgo: 0.1, payload: { cds_score: 84 } },
      { type: "pci_low", severity: "high", daysAgo: 0.3, payload: { pci_score: 0.31, threshold: 0.4 } },
      { type: "delinquency_spike", severity: "critical", daysAgo: 0.5, payload: { days_overdue: 62 } },
      { type: "pci_low", severity: "medium", daysAgo: 1, payload: { pci_score: 0.37, threshold: 0.4 } },
      { type: "cds_high", severity: "high", daysAgo: 1.5, payload: { cds_score: 78 } },
      { type: "pci_low", severity: "high", daysAgo: 2, payload: { pci_score: 0.29, threshold: 0.4 } },
      { type: "delinquency_spike", severity: "medium", daysAgo: 3, payload: { days_overdue: 41 } },
      { type: "cds_high", severity: "medium", daysAgo: 4, payload: { cds_score: 73 } },
      { type: "pci_low", severity: "low", daysAgo: 5, payload: { pci_score: 0.39, threshold: 0.4 } },
      { type: "cds_high", severity: "high", daysAgo: 6, payload: { cds_score: 80 } },
      { type: "pci_low", severity: "medium", daysAgo: 6.5, payload: { pci_score: 0.35, threshold: 0.4 } },
      { type: "delinquency_spike", severity: "high", daysAgo: 9, payload: { days_overdue: 55 }, resolved: true },
      { type: "pci_low", severity: "low", daysAgo: 11, payload: { pci_score: 0.38, threshold: 0.4 }, resolved: true },
      { type: "cds_high", severity: "medium", daysAgo: 13, payload: { cds_score: 71 }, resolved: true },
    ];
    const riskRows = specs.map((s, idx) => ({
      tenant_id: tenantId,
      borrower_id: randomUUID(),
      loan_sanction_id: loanIds[idx % loanIds.length],
      type: s.type,
      severity: s.severity,
      payload: s.payload,
      created_at: daysAgo(s.daysAgo),
      resolved_at: s.resolved ? daysAgo(s.daysAgo - 1) : null,
    }));
    console.log(`  Inserting ${riskRows.length} nbfc_risk_alerts rows…`);
    await db.insert(nbfcRiskAlerts).values(riskRows);
  }

  // 6. nbfc_borrower_actions — replace only this seed's own rows (tagged in
  //    payload) so re-running is idempotent without disturbing real actions.
  await db
    .delete(nbfcBorrowerActions)
    .where(
      and(
        eq(nbfcBorrowerActions.tenant_id, tenantId),
        sql`${nbfcBorrowerActions.payload}->>'seeded_by' = 'command-centre'`,
      ),
    );
  {
    const actionPlan: Array<[string, number]> = [
      ["payment_reminder", 4],
      ["field_visit", 3],
      ["loan_restructuring", 2],
      ["flag_for_recovery", 1],
      ["battery_immobilisation", 1],
      ["bulk_immobilisation", 1],
    ];
    const actionRows: Array<typeof nbfcBorrowerActions.$inferInsert> = [];
    let loanCursor = 0;
    for (const [type, count] of actionPlan) {
      for (let k = 0; k < count; k++) {
        actionRows.push({
          tenant_id: tenantId,
          loan_sanction_id: loanIds[loanCursor % loanIds.length],
          action_type: type,
          status: "approved",
          payload: { seeded_by: "command-centre" },
          created_at: daysAgo(0.5 + (loanCursor % 6)),
        });
        loanCursor++;
      }
    }
    console.log(`  Inserting ${actionRows.length} nbfc_borrower_actions rows…`);
    await db.insert(nbfcBorrowerActions).values(actionRows);
  }

  // 7. nbfc_recovery_pipeline (new rows, last 7 days) --------------------
  const [{ n: cmdcRecovery }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.tenant_id, tenantId),
        sql`${nbfcRecoveryPipeline.battery_serial} LIKE 'CMDC-RCV-%'`,
      ),
    );
  if (cmdcRecovery === 0) {
    console.log("  Inserting 3 nbfc_recovery_pipeline rows…");
    await db.insert(nbfcRecoveryPipeline).values([
      { tenant_id: tenantId, battery_serial: "CMDC-RCV-1", stage: "needs_inspection", estimated_recovery_value: "62000", created_at: daysAgo(2) },
      { tenant_id: tenantId, battery_serial: "CMDC-RCV-2", stage: "refurbishable", estimated_recovery_value: "88000", created_at: daysAgo(4) },
      { tenant_id: tenantId, battery_serial: "CMDC-RCV-3", stage: "needs_inspection", estimated_recovery_value: "47000", created_at: daysAgo(6) },
    ]);
  } else {
    console.log(`  Skipping nbfc_recovery_pipeline — ${cmdcRecovery} CMDC row(s) already present.`);
  }

  // 8. nbfc_immobilisation_actions (last 7 days) -------------------------
  const [{ n: immobCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nbfcImmobilisationActions)
    .where(eq(nbfcImmobilisationActions.tenant_id, tenantId));
  if (immobCount === 0) {
    console.log("  Inserting 2 nbfc_immobilisation_actions rows…");
    await db.insert(nbfcImmobilisationActions).values([
      { tenant_id: tenantId, loan_application_id: loanIds[0], imei: "8612000000001", approval_request_id: randomUUID(), iot_command_id: "CMDC-IMMO-1", executed_at: daysAgo(2), borrower_notified_at: daysAgo(2) },
      { tenant_id: tenantId, loan_application_id: loanIds[1], imei: "8612000000002", approval_request_id: randomUUID(), iot_command_id: "CMDC-IMMO-2", executed_at: daysAgo(5), borrower_notified_at: daysAgo(5) },
    ]);
  } else {
    console.log(`  Skipping nbfc_immobilisation_actions — ${immobCount} row(s) already present.`);
  }

  console.log("\nDone. Open /nbfc/portfolio (logged in as the Bajaj NBFC partner).");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
