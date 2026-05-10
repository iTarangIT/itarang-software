/**
 * E-010 — Loan sanction band guard API tests.
 *
 * BRD §6.0.5: dealer cannot sanction loans outside the active loan product's
 * loan_amount/tenure band. Server is the source of truth.
 *
 * AC1: Above max → ok=false, reason=amount_out_of_band.
 * AC2: Below min → ok=false, reason=amount_out_of_band.
 * AC3: Inactive product → ok=false, reason=product_inactive.
 * AC4: In-band amount + in-band tenure → ok=true.
 *
 * Auth: triple-guarded admin test bypass (NODE_ENV != production AND
 * NBFC_TEST_BYPASS_SECRET set on the server AND `x-nbfc-test-bypass` header
 * on the request).
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-010 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function adminBypassHeaders(opts?: { userId?: string; role?: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-user-id': opts?.userId ?? randomUUID(),
    'x-nbfc-test-user-role': opts?.role ?? 'admin',
    'content-type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = [];

async function insertTestNbfc(suffix: string): Promise<number> {
  const tag = `e010-${suffix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: tag.slice(0, 50),
      legal_name: `E-010 Test NBFC ${tag}`,
      short_name: `E010 ${tag.slice(0, 20)}`,
      rbi_registration_no: tag.slice(0, 100),
      cin: 'U65999MH2026PTC000010',
      gst_number: '27AAACT2727Q1Z0',
      pan_number: 'AAACT2727Q',
      nbfc_type: 'NBFC-ICC',
      registered_address: { line1: 'Test Address', city: 'Mumbai' },
      active_geographies: { states: ['MH'] },
      primary_contact_name: 'Test Contact',
      primary_contact_email: `${tag}@example.com`,
      primary_contact_phone: '+919999999999',
      grievance_officer_name: 'Test Officer',
      grievance_helpline: '1800-000-000',
      grievance_url: 'https://example.com/grievance',
      partnership_date: '2026-01-01',
      status: 'pending_review',
      created_by: 1,
    })
    .returning({ id: schema.nbfc.id });
  cleanup.push(async () => {
    await db.delete(schema.nbfc).where(eq(schema.nbfc.id, row.id));
  });
  return row.id;
}

interface InsertProductOpts {
  nbfcId: number;
  status?: 'active' | 'inactive';
  loanMin?: number;
  loanMax?: number;
  tenureMin?: number;
  tenureMax?: number;
  productNameTag: string;
}

async function insertTestProduct(opts: InsertProductOpts): Promise<number> {
  const [row] = await db
    .insert(schema.nbfcLoanProducts)
    .values({
      nbfc_id: opts.nbfcId,
      product_name: `E-010 Product ${opts.productNameTag}`,
      eligible_battery_categories: ['3W'],
      loan_amount_min: opts.loanMin ?? 50_000,
      loan_amount_max: opts.loanMax ?? 500_000,
      tenure_months_min: opts.tenureMin ?? 6,
      tenure_months_max: opts.tenureMax ?? 36,
      min_roi_pct: '12.00',
      max_roi_pct: '24.00',
      down_payment_pct: '10.00',
      subvention_available: false,
      file_charge_fixed: '500.00',
      file_charge_pct: null,
      disbursement_method: 'direct_to_dealer',
      status: opts.status ?? 'active',
    })
    .returning({ id: schema.nbfcLoanProducts.id });
  cleanup.push(async () => {
    await db
      .delete(schema.nbfcLoanProducts)
      .where(eq(schema.nbfcLoanProducts.id, row.id));
  });
  return row.id;
}

test.afterAll(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------

test.describe('E-010 — loan sanction band guard', () => {
  test('AC1: guard rejects sanction above max', async ({ request }) => {
    const nbfcId = await insertTestNbfc('ac1');
    const productId = await insertTestProduct({
      nbfcId,
      productNameTag: 'ac1',
      loanMin: 50_000,
      loanMax: 500_000,
      tenureMin: 6,
      tenureMax: 36,
      status: 'active',
    });

    const res = await request.post(
      '/api/admin/loan-sanctions/validate-band',
      {
        headers: adminBypassHeaders(),
        data: {
          loanProductId: productId,
          sanctionAmount: 600_000, // above 500_000 max
          tenureMonths: 24,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('amount_out_of_band');
    expect(body.product.loanAmountMax).toBe(500_000);
    expect(body.product.loanAmountMin).toBe(50_000);
    expect(body.product.status).toBe('active');
  });

  test('AC2: guard rejects sanction below min', async ({ request }) => {
    const nbfcId = await insertTestNbfc('ac2');
    const productId = await insertTestProduct({
      nbfcId,
      productNameTag: 'ac2',
      loanMin: 50_000,
      loanMax: 500_000,
      tenureMin: 6,
      tenureMax: 36,
      status: 'active',
    });

    const res = await request.post(
      '/api/admin/loan-sanctions/validate-band',
      {
        headers: adminBypassHeaders(),
        data: {
          loanProductId: productId,
          sanctionAmount: 10_000, // below 50_000 min
          tenureMonths: 12,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('amount_out_of_band');
    expect(body.product.loanAmountMin).toBe(50_000);
  });

  test('AC3: guard rejects inactive product', async ({ request }) => {
    const nbfcId = await insertTestNbfc('ac3');
    const productId = await insertTestProduct({
      nbfcId,
      productNameTag: 'ac3',
      loanMin: 50_000,
      loanMax: 500_000,
      tenureMin: 6,
      tenureMax: 36,
      status: 'inactive', // <-- key
    });

    const res = await request.post(
      '/api/admin/loan-sanctions/validate-band',
      {
        headers: adminBypassHeaders(),
        data: {
          loanProductId: productId,
          // amount + tenure are in-band; only the inactive status should bite.
          sanctionAmount: 100_000,
          tenureMonths: 12,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('product_inactive');
    expect(body.product.status).toBe('inactive');
  });

  test('AC4: guard accepts in-band sanction', async ({ request }) => {
    const nbfcId = await insertTestNbfc('ac4');
    const productId = await insertTestProduct({
      nbfcId,
      productNameTag: 'ac4',
      loanMin: 50_000,
      loanMax: 500_000,
      tenureMin: 6,
      tenureMax: 36,
      status: 'active',
    });

    const res = await request.post(
      '/api/admin/loan-sanctions/validate-band',
      {
        headers: adminBypassHeaders(),
        data: {
          loanProductId: productId,
          sanctionAmount: 200_000, // within band
          tenureMonths: 24, // within band
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reason).toBeNull();
    expect(body.product.loanAmountMin).toBe(50_000);
    expect(body.product.loanAmountMax).toBe(500_000);
    expect(body.product.tenureMonthsMin).toBe(6);
    expect(body.product.tenureMonthsMax).toBe(36);
    expect(body.product.status).toBe('active');
  });
});
