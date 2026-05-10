/**
 * E-029 — Nightly CDS computation cron + persistence.
 *
 * Standalone runner: tsx tests/nbfc/E-029.test.ts
 *
 * Loads DATABASE_URL from keys/sandbox.env (NBFC_ENV_FILE override). The
 * test invokes the App Router POST handler directly against a freshly
 * seeded NBFC + loan_sanction + emi_schedules + telemetry rows and
 * asserts borrower_risk_scores history was written.
 *
 * Acceptance criteria covered:
 *   AC1 cron returns 200 with computed_count, skipped_count, run_at ISO
 *   AC2 borrower_risk_scores receives a fresh row per active loan
 *   AC3 confidence='LOW' when fewer than 3 EMI records exist
 *   AC4 confidence='HIGH' when ≥6 EMI records and telemetry <12h fresh
 *   AC5 cds_score is always within [0, 100]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ----- env bootstrap -----
const ENV_FILE =
  process.env.NBFC_ENV_FILE ||
  path.resolve(__dirname, "../../../../../keys/sandbox.env");
if (fs.existsSync(ENV_FILE)) {
  const raw = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}
(process.env as Record<string, string | undefined>)["NODE_ENV"] =
  process.env.NODE_ENV || "test";
process.env.NBFC_TEST_BYPASS = "1";
process.env.NBFC_TEST_BYPASS_SECRET = "test-bypass";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing — env file not loaded:", ENV_FILE);
  process.exit(2);
}

const RESULTS: { id: string; name: string; ok: boolean; detail?: string }[] = [];
function pass(id: string, name: string) {
  RESULTS.push({ id, name, ok: true });
  console.log(`  PASS  ${id}  ${name}`);
}
function fail(id: string, name: string, detail: string) {
  RESULTS.push({ id, name, ok: false, detail });
  console.log(`  FAIL  ${id}  ${name}\n        ${detail}`);
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "x-nbfc-test-bypass": "test-bypass",
  } as Record<string, string>;
}

function isoDateAddDays(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function run() {
  const route = await import(
    path.resolve(__dirname, "../../src/app/api/cron/nbfc/compute-cds/route.ts")
  );
  const { db } = await import(path.resolve(__dirname, "../../src/lib/db/index.ts"));
  const schema = await import(path.resolve(__dirname, "../../src/lib/db/schema.ts"));
  const { eq, and, gte, desc } = await import("drizzle-orm");

  // ---- Seed: a synthetic tenant + 2 active loans ----
  const tenantId = randomUUID(); // synthetic nbfc tenant — we do not need to
  // create the nbfc row because borrower_risk_scores.tenant_id is just a uuid
  // (not FK). loan_sanctions.nbfc_id is loosely-typed too.

  // Loan A: 6 EMIs with mixed history + fresh telemetry  -> expect HIGH
  // Loan B: 1 EMI only                                    -> expect LOW
  // borrower_risk_scores.loan_sanction_id is typed uuid; loan_sanctions.id
  // is varchar(255). Use raw uuids for test loan ids so both tables align.
  const loanAId = randomUUID();
  const loanBId = randomUUID();
  const leadAId = `E029-LEAD-A-${randomUUID().slice(0, 8)}`;
  const leadBId = `E029-LEAD-B-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date();

  // Leads first — loan_sanctions.lead_id has a FK. Use raw SQL to keep
  // it minimal against the wide leads table.
  const uploaderId = randomUUID();
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`
    INSERT INTO leads (id, owner_name, mobile, lead_source, uploader_id)
    VALUES (${leadAId}, 'E029 Borrower A', '9000000001', 'test', ${uploaderId})
  `);
  await db.execute(sql`
    INSERT INTO leads (id, owner_name, mobile, lead_source, uploader_id)
    VALUES (${leadBId}, 'E029 Borrower B', '9000000002', 'test', ${uploaderId})
  `);

  await db.insert(schema.loanSanctions).values([
    {
      id: loanAId,
      lead_id: leadAId,
      nbfc_id: tenantId,
      status: "disbursed",
      loan_amount: "100000",
      tenure_months: 24,
      sanctioned_at: new Date(),
    },
    {
      id: loanBId,
      lead_id: leadBId,
      nbfc_id: tenantId,
      status: "disbursed",
      loan_amount: "50000",
      tenure_months: 12,
      sanctioned_at: new Date(),
    },
  ]);

  // EMI history for loan A: 6 mostly-paid rows (some late)
  const emiRowsA = [
    { due: isoDateAddDays(-180), status: "paid", days_overdue: 0 },
    { due: isoDateAddDays(-150), status: "paid", days_overdue: 0 },
    { due: isoDateAddDays(-120), status: "paid_late", days_overdue: 3 },
    { due: isoDateAddDays(-90), status: "paid", days_overdue: 0 },
    { due: isoDateAddDays(-60), status: "paid", days_overdue: 0 },
    { due: isoDateAddDays(-30), status: "paid", days_overdue: 0 },
  ];
  for (const e of emiRowsA) {
    await db.insert(schema.emiSchedules).values({
      loan_sanction_id: loanAId,
      due_date: e.due,
      status: e.status,
      days_overdue: e.days_overdue,
      paid_at: e.status.startsWith("paid") ? new Date() : null,
    });
  }

  // EMI history for loan B: only 1 EMI -> LOW confidence
  await db.insert(schema.emiSchedules).values({
    loan_sanction_id: loanBId,
    due_date: isoDateAddDays(-30),
    status: "paid",
    days_overdue: 0,
    paid_at: new Date(),
  });

  // Fresh telemetry ingestion for the tenant (within 12h)
  await db.insert(schema.telemetryIngestionLog).values({
    tenant_id: tenantId,
    battery_serial: `E029-BATT-${randomUUID().slice(0, 6)}`,
    ingested_at: new Date(),
  });

  // ---- AC1: cron POST returns 200 + counters + run_at ISO ----
  const url = "http://localhost/api/cron/nbfc/compute-cds";
  const req = new Request(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  const res: Response = await route.POST(req as unknown as import("next/server").NextRequest);
  const body = await res.json().catch(() => ({}));

  if (
    res.status === 200 &&
    body.ok === true &&
    typeof body.computed_count === "number" &&
    typeof body.skipped_count === "number" &&
    typeof body.run_at === "string" &&
    !Number.isNaN(Date.parse(body.run_at))
  ) {
    pass("AC1", "cron endpoint returns 200 with computed_count, skipped_count, run_at");
  } else {
    fail(
      "AC1",
      "cron endpoint returns 200 with computed_count, skipped_count, run_at",
      `status=${res.status} body=${JSON.stringify(body)}`,
    );
  }

  // ---- AC2: a fresh borrower_risk_scores row exists per active loan ----
  const scoresA = await db
    .select({
      cds_score: schema.borrowerRiskScores.cds_score,
      confidence: schema.borrowerRiskScores.confidence,
      computed_at: schema.borrowerRiskScores.computed_at,
    })
    .from(schema.borrowerRiskScores)
    .where(
      and(
        eq(schema.borrowerRiskScores.loan_sanction_id, loanAId),
        gte(schema.borrowerRiskScores.computed_at, startedAt),
      ),
    )
    .orderBy(desc(schema.borrowerRiskScores.computed_at));

  const scoresB = await db
    .select({
      cds_score: schema.borrowerRiskScores.cds_score,
      confidence: schema.borrowerRiskScores.confidence,
      computed_at: schema.borrowerRiskScores.computed_at,
    })
    .from(schema.borrowerRiskScores)
    .where(
      and(
        eq(schema.borrowerRiskScores.loan_sanction_id, loanBId),
        gte(schema.borrowerRiskScores.computed_at, startedAt),
      ),
    )
    .orderBy(desc(schema.borrowerRiskScores.computed_at));

  if (scoresA.length >= 1 && scoresB.length >= 1) {
    pass("AC2", "borrower_risk_scores has a fresh row per active loan_sanction");
  } else {
    fail(
      "AC2",
      "borrower_risk_scores has a fresh row per active loan_sanction",
      `scoresA=${scoresA.length} scoresB=${scoresB.length}`,
    );
  }

  // ---- AC3: <3 EMI records => confidence='LOW' ----
  if (scoresB[0]?.confidence === "LOW") {
    pass("AC3", "confidence is LOW when fewer than 3 EMI records exist");
  } else {
    fail(
      "AC3",
      "confidence is LOW when fewer than 3 EMI records exist",
      `loanB confidence=${scoresB[0]?.confidence}`,
    );
  }

  // ---- AC4: ≥6 EMI + fresh telemetry => confidence='HIGH' ----
  if (scoresA[0]?.confidence === "HIGH") {
    pass("AC4", "confidence is HIGH when EMI history (>=6) and telemetry are fresh");
  } else {
    fail(
      "AC4",
      "confidence is HIGH when EMI history (>=6) and telemetry are fresh",
      `loanA confidence=${scoresA[0]?.confidence}`,
    );
  }

  // ---- AC5: cds_score in [0, 100] ----
  const allScores = [...scoresA, ...scoresB]
    .map((s) => Number(s.cds_score))
    .filter((n) => !Number.isNaN(n));
  const ok =
    allScores.length === 2 && allScores.every((n) => n >= 0 && n <= 100);
  if (ok) {
    pass("AC5", "cds_score is bounded between 0 and 100 inclusive");
  } else {
    fail(
      "AC5",
      "cds_score is bounded between 0 and 100 inclusive",
      `scores=${JSON.stringify(allScores)}`,
    );
  }

  // ---- cleanup ----
  await db
    .delete(schema.borrowerRiskScores)
    .where(eq(schema.borrowerRiskScores.tenant_id, tenantId));
  await db
    .delete(schema.telemetryIngestionLog)
    .where(eq(schema.telemetryIngestionLog.tenant_id, tenantId));
  await db
    .delete(schema.emiSchedules)
    .where(eq(schema.emiSchedules.loan_sanction_id, loanAId));
  await db
    .delete(schema.emiSchedules)
    .where(eq(schema.emiSchedules.loan_sanction_id, loanBId));
  await db.delete(schema.loanSanctions).where(eq(schema.loanSanctions.id, loanAId));
  await db.delete(schema.loanSanctions).where(eq(schema.loanSanctions.id, loanBId));
  await db.delete(schema.leads).where(eq(schema.leads.id, leadAId));
  await db.delete(schema.leads).where(eq(schema.leads.id, leadBId));

  finish();
}

function finish() {
  const passed = RESULTS.filter((r) => r.ok).length;
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n${passed}/${RESULTS.length} acceptance criteria passed.`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((f) => f.id).join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("E-029 test runner crashed:", err);
  process.exit(2);
});
