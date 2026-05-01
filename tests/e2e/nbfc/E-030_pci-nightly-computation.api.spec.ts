/**
 * E-030 — PCI nightly computation API tests.
 *
 * AC1: POST /api/cron/nbfc/compute-pci returns 200 with computed_count,
 *      alert_triggered_count, and run_at.
 * AC2: Computed pci_score is always in [0.0, 1.0].
 * AC3: When a borrower's PCI is below 0.40 the job creates a row in
 *      nbfc_risk_alerts with type='pci_low'.
 * AC4: After the job, the latest borrower_risk_scores row for the loan has
 *      the new pci_score populated.
 *
 * The route accepts unauthenticated calls in non-production (mirrors other
 * cron routes) so we don't need the bypass header to invoke it. We DO seed
 * directly via Drizzle to control the EMI history for each test loan.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, desc, and, inArray } from "drizzle-orm";
import * as schema from "../../../src/lib/db/schema";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL must be set for E-030 API tests");
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

const RUN_ID = `e030-${Date.now()}-${randomUUID().slice(0, 6)}`;
const ctx: {
  tenantId: string;
  // Loans we seeded for this run; cleanup target.
  loanSanctionIds: string[];
  borrowerIds: string[];
  riskScoreIds: string[];
  emiIds: string[];
  alertIds: string[];
} = {
  tenantId: "",
  loanSanctionIds: [],
  borrowerIds: [],
  riskScoreIds: [],
  emiIds: [],
  alertIds: [],
};

async function seedTenant(): Promise<string> {
  const slug = `${RUN_ID}-tenant`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-030 Test NBFC ${slug}` })
    .returning();
  return row.id;
}

interface SeedLoanOpts {
  // Pattern of the most-recent N EMIs (recent first). Each entry is one of:
  //   'on_time' | 'late' | 'missed'
  pattern: Array<"on_time" | "late" | "missed">;
}

/**
 * Seed: a borrower_risk_scores baseline row + N emi_schedules rows for one
 * synthetic loan. Returns the loan_sanction_id and borrower_id so the test
 * can read back results.
 */
async function seedLoan(opts: SeedLoanOpts) {
  const loanSanctionId = randomUUID();
  const borrowerId = randomUUID();
  ctx.loanSanctionIds.push(loanSanctionId);
  ctx.borrowerIds.push(borrowerId);

  // Baseline risk score row from a "previous CDS run" 2 days ago. PCI must
  // overwrite the pci_score column on this row.
  const baselineComputedAt = new Date();
  baselineComputedAt.setUTCDate(baselineComputedAt.getUTCDate() - 2);
  const [riskRow] = await db
    .insert(schema.borrowerRiskScores)
    .values({
      tenant_id: ctx.tenantId,
      borrower_id: borrowerId,
      loan_sanction_id: loanSanctionId,
      cds_score: "55.00",
      pci_score: null,
      confidence: "medium",
      computed_at: baselineComputedAt,
    })
    .returning();
  ctx.riskScoreIds.push(riskRow.id);

  // EMI schedule rows. Most recent first → assign descending due_dates.
  for (let i = 0; i < opts.pattern.length; i++) {
    const flavour = opts.pattern[i];
    const dueDate = new Date();
    dueDate.setUTCMonth(dueDate.getUTCMonth() - (i + 1));
    const dueDateIso = dueDate.toISOString().slice(0, 10);

    let status = "missed";
    let paidAt: Date | null = null;
    let daysOverdue = 30;
    if (flavour === "on_time") {
      status = "paid";
      paidAt = new Date(dueDate);
      paidAt.setUTCDate(paidAt.getUTCDate() - 1);
      daysOverdue = 0;
    } else if (flavour === "late") {
      status = "paid_late";
      paidAt = new Date(dueDate);
      paidAt.setUTCDate(paidAt.getUTCDate() + 4);
      daysOverdue = 4;
    }

    const [row] = await db
      .insert(schema.emiSchedules)
      .values({
        loan_sanction_id: loanSanctionId,
        due_date: dueDateIso,
        paid_at: paidAt,
        status,
        days_overdue: daysOverdue,
      })
      .returning({ id: schema.emiSchedules.id });
    ctx.emiIds.push(row.id);
  }

  return { loanSanctionId, borrowerId, riskScoreId: riskRow.id };
}

test.beforeAll(async () => {
  ctx.tenantId = await seedTenant();
});

test.afterAll(async () => {
  // Order: alerts → risk_scores → emis → tenant.
  if (ctx.alertIds.length > 0) {
    await db
      .delete(schema.nbfcRiskAlerts)
      .where(inArray(schema.nbfcRiskAlerts.id, ctx.alertIds))
      .catch(() => {});
  }
  // Catch any alerts the job inserted that we didn't track explicitly.
  if (ctx.loanSanctionIds.length > 0) {
    await db
      .delete(schema.nbfcRiskAlerts)
      .where(
        inArray(
          schema.nbfcRiskAlerts.loan_sanction_id,
          ctx.loanSanctionIds,
        ),
      )
      .catch(() => {});
  }
  if (ctx.riskScoreIds.length > 0) {
    await db
      .delete(schema.borrowerRiskScores)
      .where(inArray(schema.borrowerRiskScores.id, ctx.riskScoreIds))
      .catch(() => {});
  }
  if (ctx.emiIds.length > 0) {
    await db
      .delete(schema.emiSchedules)
      .where(inArray(schema.emiSchedules.id, ctx.emiIds))
      .catch(() => {});
  }
  await db
    .delete(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.id, ctx.tenantId))
    .catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe("E-030 — PCI nightly computation", () => {
  test("AC1: PCI cron endpoint returns counts and run_at", async ({
    request,
  }) => {
    // Seed a clean healthy loan so the job has at least one computation.
    await seedLoan({
      pattern: ["on_time", "on_time", "on_time", "on_time", "on_time", "on_time"],
    });

    const res = await request.post("/api/cron/nbfc/compute-pci", {
      data: {},
    });
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.computed_count).toBe("number");
    expect(typeof body.alert_triggered_count).toBe("number");
    expect(typeof body.run_at).toBe("string");
    expect(Number.isFinite(new Date(body.run_at).getTime())).toBe(true);
    expect(body.computed_count).toBeGreaterThanOrEqual(1);
  });

  test("AC2: PCI score is bounded between 0.0 and 1.0 inclusive", async ({
    request,
  }) => {
    // Seed two loans: one at floor (all missed) and one at ceiling (all paid).
    const floorLoan = await seedLoan({
      pattern: ["missed", "missed", "missed", "missed", "missed", "missed"],
    });
    const ceilingLoan = await seedLoan({
      pattern: ["on_time", "on_time", "on_time", "on_time", "on_time", "on_time"],
    });

    const res = await request.post("/api/cron/nbfc/compute-pci", { data: {} });
    expect(res.status()).toBe(200);

    const floorRow = await db
      .select()
      .from(schema.borrowerRiskScores)
      .where(
        eq(schema.borrowerRiskScores.id, floorLoan.riskScoreId),
      )
      .limit(1);
    const ceilingRow = await db
      .select()
      .from(schema.borrowerRiskScores)
      .where(
        eq(schema.borrowerRiskScores.id, ceilingLoan.riskScoreId),
      )
      .limit(1);

    expect(floorRow[0]?.pci_score).not.toBeNull();
    expect(ceilingRow[0]?.pci_score).not.toBeNull();

    const floorPci = Number(floorRow[0]!.pci_score);
    const ceilingPci = Number(ceilingRow[0]!.pci_score);
    expect(floorPci).toBeGreaterThanOrEqual(0);
    expect(floorPci).toBeLessThanOrEqual(1);
    expect(ceilingPci).toBeGreaterThanOrEqual(0);
    expect(ceilingPci).toBeLessThanOrEqual(1);
    // Sanity: all-on-time should be near 1, all-missed near 0.
    expect(ceilingPci).toBeGreaterThan(0.95);
    expect(floorPci).toBeLessThan(0.05);
  });

  test("AC3: PCI<0.40 inserts a pci_low risk alert", async ({ request }) => {
    // Seed a borrower whose history is mostly missed → PCI ≈ 0.
    const lowLoan = await seedLoan({
      pattern: ["missed", "missed", "missed", "missed", "missed", "missed"],
    });

    const res = await request.post("/api/cron/nbfc/compute-pci", { data: {} });
    expect(res.status()).toBe(200);

    const alerts = await db
      .select()
      .from(schema.nbfcRiskAlerts)
      .where(
        and(
          eq(schema.nbfcRiskAlerts.loan_sanction_id, lowLoan.loanSanctionId),
          eq(schema.nbfcRiskAlerts.type, "pci_low"),
        ),
      );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    for (const a of alerts) ctx.alertIds.push(a.id);

    expect(alerts[0].borrower_id).toBe(lowLoan.borrowerId);
    expect(alerts[0].tenant_id).toBe(ctx.tenantId);
    // Severity should be high or critical.
    expect(["high", "critical"]).toContain(alerts[0].severity);
  });

  test("AC4: PCI is persisted on borrower_risk_scores", async ({ request }) => {
    // Seed a fresh loan with a deterministic mid-range pattern.
    const loan = await seedLoan({
      pattern: ["on_time", "late", "on_time", "late", "on_time", "late"],
    });

    const res = await request.post("/api/cron/nbfc/compute-pci", { data: {} });
    expect(res.status()).toBe(200);

    // Re-read the most recent borrower_risk_scores row for the loan.
    const rows = await db
      .select()
      .from(schema.borrowerRiskScores)
      .where(
        and(
          eq(schema.borrowerRiskScores.loan_sanction_id, loan.loanSanctionId),
          eq(schema.borrowerRiskScores.tenant_id, ctx.tenantId),
        ),
      )
      .orderBy(desc(schema.borrowerRiskScores.computed_at))
      .limit(1);

    expect(rows.length).toBe(1);
    expect(rows[0].pci_score).not.toBeNull();
    const pci = Number(rows[0].pci_score);
    // Mix of on_time (1.0) + late (0.5) → expected ≈ 0.75.
    expect(pci).toBeGreaterThan(0.6);
    expect(pci).toBeLessThan(0.9);
  });
});
