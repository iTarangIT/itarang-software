#!/usr/bin/env -S tsx
/**
 * E-026 acceptance-criteria test — calls computePortfolioSummary directly.
 *
 * AC1 — six numeric fields + ISO computed_at
 * AC2 — total_active_loans counts only disbursed-open for that tenant
 * AC3 — delinquency_rate = 0 when total_active_loans = 0
 * AC4 — Cross-tenant rows MUST NOT leak into one tenant's aggregates.
 */
import postgres from "postgres";
// dotenv must be loaded BEFORE any module that reads DATABASE_URL.
import "dotenv/config";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing — set NBFC_ENV_FILE or export DATABASE_URL");
  process.exit(2);
}

// Lazy-load to ensure env is in place first.
async function loadCompute() {
  const m = await import("../src/lib/nbfc/portfolio-summary");
  return m.computePortfolioSummary;
}

const sql = postgres(process.env.DATABASE_URL!, { ssl: "prefer", max: 4 });

const MARKER = "E026TEST_";
const SLUG_A = `${MARKER.toLowerCase()}tenant-a`;
const SLUG_B = `${MARKER.toLowerCase()}tenant-b`;
const SLUG_C = `${MARKER.toLowerCase()}tenant-c`;

interface TestResult {
  ac: string;
  ok: boolean;
  note: string;
}
const results: TestResult[] = [];
function record(ac: string, ok: boolean, note: string) {
  results.push({ ac, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"} ${ac}: ${note}`);
}

async function ensureTenant(slug: string, name: string) {
  const rows = await sql<{ id: string; slug: string }[]>`
    INSERT INTO nbfc_tenants (slug, display_name, is_active)
    VALUES (${slug}, ${name}, true)
    ON CONFLICT (slug) DO UPDATE SET is_active = true, display_name = EXCLUDED.display_name
    RETURNING id, slug`;
  return rows[0];
}

async function cleanupTenant(tenantId: string) {
  await sql`DELETE FROM borrower_risk_scores WHERE tenant_id = ${tenantId}`;
  await sql`DELETE FROM nbfc_recovery_pipeline WHERE tenant_id = ${tenantId}`;
  await sql`DELETE FROM loan_sanctions WHERE nbfc_id = ${tenantId} AND id LIKE ${`${MARKER}%`}`;
  await sql`DELETE FROM nbfc_loans WHERE tenant_id = ${tenantId} AND loan_application_id LIKE ${`${MARKER}%`}`;
  await sql`DELETE FROM leads WHERE id LIKE ${`${MARKER}lead_%`}`;
}

async function ensureLead(leadId: string) {
  // leads has 3 required no-default columns: id, lead_source, uploader_id.
  await sql`
    INSERT INTO leads (id, lead_source, uploader_id)
    VALUES (${leadId}, ${"e026_test"}, gen_random_uuid())
    ON CONFLICT (id) DO NOTHING`;
}

async function seedTenant(
  tenant: { id: string; slug: string },
  opts: {
    activeLoans: number;
    loanAmount?: number;
    disbAmount?: number;
    disbursedThisMonth?: boolean;
    closedLoan?: boolean;
    cdsScores?: number[];
    recovery?: { stage: string; value: number }[];
  },
) {
  const now = new Date();
  for (let i = 0; i < opts.activeLoans; i++) {
    const id = `${MARKER}${tenant.slug}_active_${i}`;
    const leadId = `${MARKER}lead_${tenant.slug}_${i}`;
    await ensureLead(leadId);
    await sql`
      INSERT INTO loan_sanctions (id, lead_id, status, nbfc_id, loan_amount, disbursement_amount, disbursed_at, closed_at)
      VALUES (
        ${id}, ${leadId}, 'disbursed',
        ${tenant.id}, ${opts.loanAmount ?? 100000}, ${opts.disbAmount ?? 90000},
        ${
          opts.disbursedThisMonth
            ? now.toISOString()
            : new Date(now.getFullYear() - 1, 0, 1).toISOString()
        },
        NULL
      )`;
  }
  if (opts.closedLoan) {
    const leadId = `${MARKER}lead_${tenant.slug}_closed`;
    await ensureLead(leadId);
    await sql`
      INSERT INTO loan_sanctions (id, lead_id, status, nbfc_id, loan_amount, disbursement_amount, disbursed_at, closed_at)
      VALUES (${`${MARKER}${tenant.slug}_closed`}, ${leadId}, 'disbursed',
              ${tenant.id}, 50000, 50000, ${new Date(now.getFullYear() - 1, 0, 1).toISOString()},
              ${new Date().toISOString()})`;
  }
  for (const score of opts.cdsScores ?? []) {
    await sql`
      INSERT INTO borrower_risk_scores (tenant_id, borrower_id, loan_sanction_id, cds_score)
      VALUES (${tenant.id}, gen_random_uuid(), gen_random_uuid(), ${score})`;
  }
  for (const row of opts.recovery ?? []) {
    await sql`
      INSERT INTO nbfc_recovery_pipeline (tenant_id, battery_serial, stage, estimated_recovery_value)
      VALUES (${tenant.id}, ${`${MARKER}bat_${Math.random().toString(36).slice(2, 8)}`}, ${row.stage}, ${row.value})`;
  }
}

async function main() {
  const a = await ensureTenant(SLUG_A, "E-026 Test Tenant A");
  const b = await ensureTenant(SLUG_B, "E-026 Test Tenant B");
  const c = await ensureTenant(SLUG_C, "E-026 Test Tenant C (empty)");
  await cleanupTenant(a.id);
  await cleanupTenant(b.id);
  await cleanupTenant(c.id);

  await seedTenant(a, {
    activeLoans: 3,
    loanAmount: 100000,
    disbAmount: 95000,
    disbursedThisMonth: true,
    closedLoan: true,
    cdsScores: [620, 720],
    recovery: [
      { stage: "needs_inspection", value: 30000 },
      { stage: "ready_for_auction", value: 20000 },
      { stage: "resold", value: 99999 },
    ],
  });
  await seedTenant(b, {
    activeLoans: 5,
    loanAmount: 200000,
    disbAmount: 180000,
    disbursedThisMonth: false,
    cdsScores: [500, 510, 520],
    recovery: [
      { stage: "refurbishable", value: 50000 },
      { stage: "scrap", value: 10000 },
    ],
  });

  // ---- AC1
  {
    const s = await (await loadCompute())(a.id);
    const six = [
      "total_active_loans",
      "portfolio_value",
      "disbursement_this_month",
      "delinquency_rate",
      "avg_portfolio_cds",
      "recovery_value_locked",
    ] as const;
    const allNumeric = six.every(
      (k) => typeof (s as unknown as Record<string, unknown>)[k] === "number",
    );
    const isoOk =
      typeof s.computed_at === "string" && !Number.isNaN(Date.parse(s.computed_at));
    record(
      "AC1",
      allNumeric && isoOk,
      `keys=${Object.keys(s).join(",")} computed_at=${s.computed_at}`,
    );
  }

  // ---- AC2
  {
    const s = await (await loadCompute())(a.id);
    const ok = s.total_active_loans === 3 && s.portfolio_value === 300000;
    record(
      "AC2",
      ok,
      `total_active_loans=${s.total_active_loans} (want 3); portfolio_value=${s.portfolio_value} (want 300000)`,
    );
  }

  // ---- AC3
  {
    const s = await (await loadCompute())(c.id);
    const ok =
      s.total_active_loans === 0 &&
      s.delinquency_rate === 0 &&
      Number.isFinite(s.delinquency_rate);
    record(
      "AC3",
      ok,
      `total_active_loans=${s.total_active_loans} delinquency_rate=${s.delinquency_rate}`,
    );
  }

  // ---- AC4
  {
    const sa = await (await loadCompute())(a.id);
    const sb = await (await loadCompute())(b.id);
    const aIsolated =
      sa.total_active_loans === 3 &&
      sa.portfolio_value === 300000 &&
      sa.recovery_value_locked === 50000 &&
      sa.avg_portfolio_cds === 670; // (620+720)/2
    const bIsolated =
      sb.total_active_loans === 5 &&
      sb.portfolio_value === 1000000 &&
      sb.recovery_value_locked === 60000 &&
      sb.avg_portfolio_cds === 510; // (500+510+520)/3
    record(
      "AC4",
      aIsolated && bIsolated,
      `A: total=${sa.total_active_loans} portfolio=${sa.portfolio_value} recovery=${sa.recovery_value_locked} cds=${sa.avg_portfolio_cds} | ` +
        `B: total=${sb.total_active_loans} portfolio=${sb.portfolio_value} recovery=${sb.recovery_value_locked} cds=${sb.avg_portfolio_cds}`,
    );
  }

  // Cleanup
  await cleanupTenant(a.id);
  await cleanupTenant(b.id);
  await cleanupTenant(c.id);
  await sql`UPDATE nbfc_tenants SET is_active = false WHERE slug IN (${SLUG_A}, ${SLUG_B}, ${SLUG_C})`;

  await sql.end({ timeout: 5 });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n=== E-026 ACs: ${passed}/${results.length} passed ===`);
  console.log(JSON.stringify({ passed, failed, total: results.length, results }));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("fatal", e);
  try {
    await sql.end({ timeout: 1 });
  } catch {}
  process.exit(2);
});
