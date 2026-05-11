/**
 * E-092 — CDS/PCI Score Explainability Drawer API tests (BRD §6.4.5)
 *
 * AC1: GET returns 200 with formula_text containing the BRD CDS sentence and
 *      inputs.last_6_emis length <= 6, sorted newest-first by due_date.
 * AC2: When the loan has fewer than 3 EMI records, confidence.level == 'LOW'
 *      and reasons contains 'Insufficient history (<3 EMIs)'.
 * AC3: when_not_to_trust equals the BRD-mandated four items verbatim.
 * AC4: GET with score_type not in {'cds','pci'} returns 400.
 * AC5: GET for a loan with no score run returns 404.
 *
 * Auth: triple-guarded test bypass (NODE_ENV != production AND
 * NBFC_TEST_BYPASS_SECRET on server AND x-nbfc-test-bypass header on request).
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-092 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function bypassHeaders(opts: { tenantId: string; userId: string; role: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-tenant-id': opts.tenantId,
    'x-nbfc-test-user-id': opts.userId,
    'x-nbfc-test-user-role': opts.role,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ROLE = 'nbfc_credit_manager';

const ctx: { tenantId: string } = { tenantId: '' };
const createdLoanIds: string[] = [];
const createdParentIds: string[] = [];
const createdRunIds: string[] = [];

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e092-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-092 Test NBFC ${slug}` })
    .returning();
  return row.id;
}

async function makeLoan(tenantId: string): Promise<string> {
  // nbfc_loans.loan_application_id has an FK to loan_applications.id (present
  // in the sandbox DB but not modelled in schema.ts), and loan_applications
  // itself has a NOT NULL lead_id with its own FK to leads. To avoid seeding
  // the whole graph, we insert a per-test loan_applications row that reuses
  // an existing row's lead_id, then point an nbfc_loans row at it.
  const id = `e092-loan-${randomUUID().slice(0, 8)}`;
  const existing = await db
    .select({
      id: schema.loanApplications.id,
      lead_id: schema.loanApplications.lead_id,
    })
    .from(schema.loanApplications)
    .limit(1);
  const leadId = existing[0]?.lead_id;
  if (!leadId) {
    throw new Error(
      'No loan_applications rows exist; cannot satisfy nbfc_loans.loan_application_id FK',
    );
  }
  await db
    .insert(schema.loanApplications)
    .values({ id, lead_id: leadId } as never);
  createdParentIds.push(id);

  await db.insert(schema.nbfcLoans).values({
    tenant_id: tenantId,
    loan_application_id: id,
    is_active: true,
  });
  createdLoanIds.push(id);
  return id;
}

async function makeScoreRun(opts: {
  loanApplicationId: string;
  scoreType: 'cds' | 'pci';
  emiCount: number;
  scoreValue?: number;
}): Promise<string> {
  const [run] = await db
    .insert(schema.nbfcScoreRuns)
    .values({
      loan_application_id: opts.loanApplicationId,
      score_type: opts.scoreType,
      score_value: String(opts.scoreValue ?? 72.5),
      confidence_level: opts.emiCount < 3 ? 'LOW' : 'HIGH',
      confidence_reasons:
        opts.emiCount < 3 ? ['Insufficient history (<3 EMIs)'] : [],
    })
    .returning();
  createdRunIds.push(run.id);

  // Insert N EMI snapshot rows. due_date strictly increases so that newest-
  // first ordering can be asserted.
  const rows = [];
  const base = Date.now();
  for (let i = 0; i < opts.emiCount; i++) {
    rows.push({
      score_run_id: run.id,
      row_index: i,
      due_date: new Date(base - (opts.emiCount - 1 - i) * 30 * 86400 * 1000),
      amount: '5000.00',
      status: i % 2 === 0 ? 'paid' : 'late',
      days_late: i % 2 === 0 ? 0 : 5,
      contribution: String((i + 1) * 1.5),
    });
  }
  if (rows.length > 0) {
    await db.insert(schema.nbfcScoreInputSnapshots).values(rows);
  }
  return run.id;
}

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant();
});

test.afterAll(async () => {
  for (const runId of createdRunIds) {
    await db
      .delete(schema.nbfcScoreInputSnapshots)
      .where(eq(schema.nbfcScoreInputSnapshots.score_run_id, runId))
      .catch(() => {});
    await db
      .delete(schema.nbfcScoreRuns)
      .where(eq(schema.nbfcScoreRuns.id, runId))
      .catch(() => {});
  }
  for (const loanId of createdLoanIds) {
    await db
      .delete(schema.nbfcLoans)
      .where(
        and(
          eq(schema.nbfcLoans.tenant_id, ctx.tenantId),
          eq(schema.nbfcLoans.loan_application_id, loanId),
        ),
      )
      .catch(() => {});
  }
  for (const parentId of createdParentIds) {
    await db
      .delete(schema.loanApplications)
      .where(eq(schema.loanApplications.id, parentId))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe('E-092 — Score Explainability', () => {
  test('AC1: returns formula and last-6 EMIs newest-first', async ({ request }) => {
    const loanId = await makeLoan(ctx.tenantId);
    await makeScoreRun({
      loanApplicationId: loanId,
      scoreType: 'cds',
      emiCount: 8, // more than 6 so we can verify the cap
      scoreValue: 78.42,
    });

    const res = await request.get(
      `/api/nbfc/scores/explainability?loan_application_id=${encodeURIComponent(
        loanId,
      )}&score_type=cds`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.score_type).toBe('cds');
    expect(typeof body.score_value).toBe('number');
    expect(String(body.formula_text)).toContain(
      'CDS = sum of EMI weights × recency multipliers + streak penalty, scaled 0–100',
    );

    const emis: Array<{ due_date: string | null }> = body.inputs.last_6_emis;
    expect(emis.length).toBeLessThanOrEqual(6);
    expect(emis.length).toBeGreaterThan(0);

    // newest-first: each due_date >= the next
    for (let i = 0; i < emis.length - 1; i++) {
      const a = emis[i].due_date ? Date.parse(emis[i].due_date as string) : 0;
      const b = emis[i + 1].due_date
        ? Date.parse(emis[i + 1].due_date as string)
        : 0;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });

  test('AC2: confidence.level=LOW when EMI history < 3', async ({ request }) => {
    const loanId = await makeLoan(ctx.tenantId);
    await makeScoreRun({
      loanApplicationId: loanId,
      scoreType: 'cds',
      emiCount: 2,
    });

    const res = await request.get(
      `/api/nbfc/scores/explainability?loan_application_id=${encodeURIComponent(
        loanId,
      )}&score_type=cds`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.confidence.level).toBe('LOW');
    expect(body.confidence.reasons).toContain('Insufficient history (<3 EMIs)');
  });

  test('AC3: when_not_to_trust equals BRD-mandated four items verbatim', async ({
    request,
  }) => {
    const loanId = await makeLoan(ctx.tenantId);
    await makeScoreRun({
      loanApplicationId: loanId,
      scoreType: 'pci',
      emiCount: 4,
    });

    const res = await request.get(
      `/api/nbfc/scores/explainability?loan_application_id=${encodeURIComponent(
        loanId,
      )}&score_type=pci`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.when_not_to_trust).toEqual([
      'Insufficient history (<3 EMIs)',
      'Recent restructuring',
      'Declared force majeure',
      'Manual override active',
    ]);
  });

  test('AC4: unsupported score_type returns 400', async ({ request }) => {
    const loanId = await makeLoan(ctx.tenantId);

    const res = await request.get(
      `/api/nbfc/scores/explainability?loan_application_id=${encodeURIComponent(
        loanId,
      )}&score_type=foo`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
      },
    );
    expect(res.status()).toBe(400);
  });

  test('AC5: 404 when no score run exists for the loan', async ({ request }) => {
    const loanId = await makeLoan(ctx.tenantId); // no score run inserted

    const res = await request.get(
      `/api/nbfc/scores/explainability?loan_application_id=${encodeURIComponent(
        loanId,
      )}&score_type=cds`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
      },
    );
    expect(res.status()).toBe(404);
  });
});
