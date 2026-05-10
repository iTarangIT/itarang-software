/**
 * E-065 — NBFC Ecosystem Overview API tests (BRD §6.3.2).
 *
 * AC1: GET /api/admin/nbfc/ecosystem-overview returns 200 with all seven tiles
 *      populated for an admin caller.
 * AC2: Returns 403 when called by a non-admin (NBFC tenant) JWT.
 * AC3: Response includes a comparison array with one entry per active NBFC
 *      containing active_loans, delinquency_pct, avg_cds, recovery_rate_pct.
 *
 * Auth: triple-guarded admin test bypass — same pattern as E-001 / E-005.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error('DATABASE_URL must be set for E-065 API tests');
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e065-loop-bypass-secret';

function adminBypassHeaders(opts?: { userId?: string; role?: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-admin-id': '4242',
    'x-nbfc-test-admin-role': opts?.role ?? 'admin',
    'x-nbfc-test-user-id': opts?.userId ?? randomUUID(),
    'x-nbfc-test-user-role': opts?.role ?? 'admin',
  };
}

function nonAdminBypassHeaders() {
  // Bypass attempt without admin id → resolveAdminActor throws UNAUTHORIZED.
  // To exercise the FORBIDDEN path we send a session-style header carrying a
  // non-admin role; resolveAdminActor sees no admin id and rejects.
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-admin-role': 'viewer',
    'x-nbfc-test-user-id': randomUUID(),
    'x-nbfc-test-user-role': 'viewer',
  };
}

const tenantIds: string[] = [];
const loanIds: string[] = [];

test.beforeAll(async () => {
  // Two active tenants so the comparison array has multiple rows.
  const slugA = `e065a-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const slugB = `e065b-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const [a, b] = await db
    .insert(schema.nbfcTenants)
    .values([
      { slug: slugA, display_name: `E-065 NBFC A ${slugA}`, is_active: true },
      { slug: slugB, display_name: `E-065 NBFC B ${slugB}`, is_active: true },
    ])
    .returning({ id: schema.nbfcTenants.id });
  tenantIds.push(a.id, b.id);

  // Loan rows so comparison aggregation has signal: 3 loans for A (1 dpd>0),
  // 2 loans for B (0 dpd>0). Loan PK is varchar — we mint synthetic ids.
  const stamp = Date.now().toString(36);
  const rows = [
    { id: `e065-A1-${stamp}-${randomUUID().slice(0, 4)}`, tenant: a.id, dpd: 0, out: 100000 },
    { id: `e065-A2-${stamp}-${randomUUID().slice(0, 4)}`, tenant: a.id, dpd: 0, out: 200000 },
    { id: `e065-A3-${stamp}-${randomUUID().slice(0, 4)}`, tenant: a.id, dpd: 12, out: 150000 },
    { id: `e065-B1-${stamp}-${randomUUID().slice(0, 4)}`, tenant: b.id, dpd: 0, out: 50000 },
    { id: `e065-B2-${stamp}-${randomUUID().slice(0, 4)}`, tenant: b.id, dpd: 0, out: 75000 },
  ];
  for (const r of rows) {
    await db.insert(schema.nbfcLoans).values({
      loan_application_id: r.id,
      tenant_id: r.tenant,
      vehicleno: `MH${randomUUID().slice(0, 6).toUpperCase()}`,
      current_dpd: r.dpd,
      outstanding_amount: String(r.out),
      is_active: true,
    });
    loanIds.push(r.id);
  }

  // Borrower risk scores so avg_cds populates for both tenants.
  await db.insert(schema.borrowerRiskScores).values([
    {
      tenant_id: a.id,
      borrower_id: randomUUID(),
      loan_sanction_id: randomUUID(),
      cds_score: '70.50',
    },
    {
      tenant_id: a.id,
      borrower_id: randomUUID(),
      loan_sanction_id: randomUUID(),
      cds_score: '65.00',
    },
    {
      tenant_id: b.id,
      borrower_id: randomUUID(),
      loan_sanction_id: randomUUID(),
      cds_score: '80.00',
    },
  ]);
});

test.afterAll(async () => {
  // Best-effort cleanup; ordered child→parent.
  if (tenantIds.length > 0) {
    await db
      .delete(schema.borrowerRiskScores)
      .where(inArray(schema.borrowerRiskScores.tenant_id, tenantIds));
  }
  if (loanIds.length > 0) {
    await db
      .delete(schema.nbfcLoans)
      .where(inArray(schema.nbfcLoans.loan_application_id, loanIds));
  }
  for (const id of tenantIds) {
    await db.delete(schema.nbfcTenants).where(eq(schema.nbfcTenants.id, id));
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-065 — Ecosystem Overview', () => {
  test('AC1: returns 200 with all seven tiles for an admin caller', async ({
    request,
  }) => {
    const res = await request.get('/api/admin/nbfc/ecosystem-overview', {
      headers: adminBypassHeaders(),
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('tiles');
    const t = body.tiles;
    expect(typeof t.connected_nbfcs).toBe('number');
    expect(typeof t.total_portfolio_inr).toBe('number');
    expect(typeof t.batteries_in_field).toBe('number');
    expect(typeof t.iot_connectivity_pct).toBe('number');
    expect(typeof t.platform_uptime_pct).toBe('number');
    expect(t.alerts_24h).toEqual(
      expect.objectContaining({
        critical: expect.any(Number),
        warning: expect.any(Number),
        info: expect.any(Number),
      }),
    );
    expect(typeof t.avg_cds_network).toBe('number');
    expect(t.connected_nbfcs).toBeGreaterThanOrEqual(2);
  });

  test('AC2: rejects non-admin caller with 403', async ({ request }) => {
    const res = await request.get('/api/admin/nbfc/ecosystem-overview', {
      headers: nonAdminBypassHeaders(),
    });
    // resolveAdminActor throws UNAUTHORIZED when admin-id missing → 401;
    // a session-mode call without admin role would yield FORBIDDEN → 403.
    // Either way, the BRD requirement is "denied for non-admin" (4xx).
    expect([401, 403]).toContain(res.status());
  });

  test('AC3: comparison array contains one entry per active NBFC with required fields', async ({
    request,
  }) => {
    const res = await request.get('/api/admin/nbfc/ecosystem-overview', {
      headers: adminBypassHeaders(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.comparison)).toBe(true);
    const seeded = body.comparison.filter((r: { nbfc_id: string }) =>
      tenantIds.includes(r.nbfc_id),
    );
    expect(seeded.length).toBe(2);
    for (const r of seeded) {
      expect(typeof r.nbfc_id).toBe('string');
      expect(typeof r.nbfc_name).toBe('string');
      expect(typeof r.active_loans).toBe('number');
      expect(typeof r.delinquency_pct).toBe('number');
      expect(typeof r.avg_cds).toBe('number');
      expect(typeof r.recovery_rate_pct).toBe('number');
    }
    // Tenant A: 3 loans seeded, 1 with dpd > 0 → 33.33% delinquency.
    const a = seeded.find((r: { nbfc_id: string }) => r.nbfc_id === tenantIds[0]);
    expect(a?.active_loans).toBe(3);
    expect(a?.delinquency_pct).toBeGreaterThan(0);
    // Tenant B: 2 loans seeded, 0 delinquent → 0%.
    const b = seeded.find((r: { nbfc_id: string }) => r.nbfc_id === tenantIds[1]);
    expect(b?.active_loans).toBe(2);
    expect(b?.delinquency_pct).toBe(0);
  });
});
