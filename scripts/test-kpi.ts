/**
 * Test ONE Portfolio Command Centre KPI card at a time.
 *
 * Usage (from the VS Code terminal):
 *   node --import tsx --env-file=.env.local scripts/test-kpi.ts active-loans
 *   node --import tsx --env-file=.env.local scripts/test-kpi.ts at-risk
 *   node --import tsx --env-file=.env.local scripts/test-kpi.ts delinquency
 *   node --import tsx --env-file=.env.local scripts/test-kpi.ts recovery
 *
 * Optional 2nd arg = tenant id (defaults to iTarang Finance).
 *
 * Each branch mirrors the exact query used by the real source so you can test
 * and understand the cards independently:
 *   - active-loans → computePortfolioSummary() + deltaActiveLoansQoQ()  (command-centre.ts)
 *   - at-risk      → computeAtRiskIds()                                  (command-centre.ts)
 *   - delinquency  → computePortfolioSummary()                          (portfolio-summary.ts)
 *   - recovery     → computeRecoveryInMotion()                          (command-centre.ts)
 */
import "dotenv/config";
import { and, eq, isNull, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  loanSanctions,
  emiSchedules,
  nbfcLoans,
  telemetryAlerts,
  nbfcRecoveryPipeline,
} from "@/lib/db/schema";

const card = (process.argv[2] ?? "").toLowerCase();
const TENANT = process.argv[3] ?? "02bda647-c164-4e81-809b-01cfe159cdb6"; // iTarang Finance
const QUARTER_MS = 90 * 24 * 60 * 60 * 1000;

async function activeIds(): Promise<string[]> {
  const rows = await db
    .select({ id: loanSanctions.id })
    .from(loanSanctions)
    .where(
      and(
        eq(loanSanctions.nbfc_id, TENANT),
        eq(loanSanctions.status, "disbursed"),
        isNull(loanSanctions.closed_at),
      ),
    );
  return rows.map((r) => r.id);
}

async function runActiveLoans() {
  const ids = await activeIds();
  const value = ids.length;

  // delta vs ~90 days ago (deltaActiveLoansQoQ)
  const asOf = new Date(Date.now() - QUARTER_MS).toISOString();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loanSanctions)
    .where(
      and(
        eq(loanSanctions.nbfc_id, TENANT),
        sql`${loanSanctions.disbursed_at} < ${asOf}`,
        or(isNull(loanSanctions.closed_at), sql`${loanSanctions.closed_at} > ${asOf}`),
      ),
    );
  const prior = row?.n ?? 0;
  const diff = value - prior;
  console.log("ACTIVE LOANS value =", value);
  console.log("  delta            =", prior === 0 ? "null (no baseline)" : `${diff >= 0 ? "+" : ""}${diff} QoQ`);
}

async function runAtRisk() {
  const ids = await activeIds();
  const set = new Set<string>();
  if (ids.length) {
    const overdue = await db
      .selectDistinct({ id: emiSchedules.loan_sanction_id })
      .from(emiSchedules)
      .where(
        and(
          inArray(emiSchedules.loan_sanction_id, ids),
          inArray(emiSchedules.status, ["overdue", "missed"]),
          sql`COALESCE(${emiSchedules.days_overdue}, 0) > 30`,
        ),
      );
    overdue.forEach((r) => set.add(r.id));

    const flagged = await db
      .selectDistinct({ id: nbfcLoans.loan_application_id })
      .from(telemetryAlerts)
      .innerJoin(nbfcLoans, eq(nbfcLoans.vehicleno, telemetryAlerts.serial_number))
      .where(
        and(
          eq(nbfcLoans.tenant_id, TENANT),
          isNull(telemetryAlerts.resolved_at),
          inArray(telemetryAlerts.severity, ["critical", "warning"]),
        ),
      );
    flagged.forEach((r) => { if (ids.includes(r.id)) set.add(r.id); });
  }
  const total = ids.length;
  console.log("AT-RISK value      =", set.size);
  console.log("  pct_of_book      =", total === 0 ? 0 : Math.round((set.size / total) * 1000) / 10, "%");
  console.log("  at-risk loan ids =", [...set]);
}

async function runDelinquency() {
  const ids = await activeIds();
  const total = ids.length;
  let overdueCount = 0;
  if (total) {
    const rows = await db
      .selectDistinct({ id: emiSchedules.loan_sanction_id })
      .from(emiSchedules)
      .where(
        and(
          inArray(emiSchedules.loan_sanction_id, ids),
          inArray(emiSchedules.status, ["overdue", "missed"]),
          sql`COALESCE(${emiSchedules.days_overdue}, 0) > 30`,
        ),
      );
    overdueCount = rows.length;
  }
  const rate = total === 0 ? 0 : Math.round((overdueCount / total) * 100 * 100) / 100;
  console.log("DELINQUENCY rate   =", rate, "%");
  console.log("  overdue_count    =", overdueCount);
  console.log("  total_active     =", total);
}

async function runRecovery() {
  const rows = await db
    .select({ v: nbfcRecoveryPipeline.estimated_recovery_value })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.tenant_id, TENANT),
        sql`${nbfcRecoveryPipeline.stage} <> 'resold'`,
      ),
    );
  console.log("RECOVERY count     =", rows.length);
  console.log("  amount_inr       =", rows.reduce((a, r) => a + (r.v != null ? Number(r.v) : 0), 0));
}

async function main() {
  console.log("Tenant:", TENANT, "| Card:", card || "(none)", "\n");
  switch (card) {
    case "active-loans": await runActiveLoans(); break;
    case "at-risk":      await runAtRisk(); break;
    case "delinquency":  await runDelinquency(); break;
    case "recovery":     await runRecovery(); break;
    default:
      console.log("Pick a card:  active-loans | at-risk | delinquency | recovery");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
