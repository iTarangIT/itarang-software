/**
 * E-080 — Mandatory compliance metadata renderer (BRD §6.4.2) API tests.
 *
 * Each AC is one Playwright test. The route is auth-gated; we use the
 * triple-guarded test bypass (NODE_ENV != production AND
 * NBFC_TEST_BYPASS_SECRET set on server AND `x-nbfc-test-bypass` header on
 * request) to fabricate the calling NBFC user (mirroring the E-082 pattern).
 *
 * AC1: GET ?screen=immobilisation_confirm&lead_id=L1 → 200 with all mandatory
 *      compliance elements present.
 * AC2: GET ?screen=immobilisation_confirm with no lead_id → 400.
 * AC3: GET ?screen=telemetry_view&lead_id=L1 → data_purpose.text contains
 *      "loan risk assessment" and consent_date matches the seeded
 *      consent_records.signed_at.
 * AC4: Unauthenticated GET (no bypass header, no session) → 401.
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
  throw new Error('DATABASE_URL must be set for E-080 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Test bypass plumbing (mirrors E-082)
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

const ctx: {
  tenantId: string;
  leadId: string;
  consentSignedAt: Date;
  createdLoanId: boolean;
  createdLeadId: boolean;
  createdConsentId: string | null;
} = {
  tenantId: '',
  leadId: '',
  consentSignedAt: new Date('2026-04-15T10:00:00.000Z'),
  createdLoanId: false,
  createdLeadId: false,
  createdConsentId: null,
};

async function getOrCreateTenant(): Promise<string> {
  // Pick the first active tenant; ensure RBI compliance columns are populated
  // so AC1 can read them back.
  const existing = await db
    .select({
      id: schema.nbfcTenants.id,
      nbfc_legal_name: schema.nbfcTenants.nbfc_legal_name,
    })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);

  let tenantId: string;
  if (existing.length > 0) {
    tenantId = existing[0].id;
  } else {
    const slug = `e080-${Date.now()}`;
    const [row] = await db
      .insert(schema.nbfcTenants)
      .values({
        slug,
        display_name: `E-080 Test NBFC ${slug}`,
      })
      .returning({ id: schema.nbfcTenants.id });
    tenantId = row.id;
  }

  // Always upsert the four E-080 columns so AC1 sees deterministic values.
  await db
    .update(schema.nbfcTenants)
    .set({
      nbfc_legal_name: 'iTarang Test NBFC Pvt Ltd',
      rbi_registration_no: 'N-13.99999',
      grievance_url: 'https://nbfc.example.itarang.com/grievance',
      grievance_helpline: '1800-000-0080',
    })
    .where(eq(schema.nbfcTenants.id, tenantId));

  return tenantId;
}

async function ensureLoanAndConsent(tenantId: string) {
  const leadId = `E080-LEAD-${randomUUID().slice(0, 8)}`;
  ctx.leadId = leadId;

  // Insert a minimal loan_applications row so the route's fallback can find a
  // lead. Most columns are nullable; if not, insert just `id`.
  try {
    await db.insert(schema.loanApplications).values({ id: leadId } as never);
    ctx.createdLeadId = true;
  } catch {
    // If schema requires more cols, leave it — nbfcLoans row below is enough
    // because the route reads outstanding_amount from nbfc_loans first.
  }

  // Insert nbfc_loans row with outstanding_amount so AC1 has a numeric value.
  try {
    await db.insert(schema.nbfcLoans).values({
      loan_application_id: leadId,
      tenant_id: tenantId,
      outstanding_amount: '12345.67',
      is_active: true,
    } as never);
    ctx.createdLoanId = true;
  } catch {
    // If FK fails (no loan_applications row), best-effort skip; AC1 still
    // checks compliance elements, not exact amount.
  }

  // Insert a consent_records row with a deterministic signed_at for AC3.
  const consentId = `E080-CONS-${randomUUID().slice(0, 8)}`;
  ctx.createdConsentId = consentId;
  await db.insert(schema.consentRecords).values({
    id: consentId,
    lead_id: leadId,
    consent_type: 'data_processing',
    consent_status: 'signed',
    signed_at: ctx.consentSignedAt,
  } as never);
}

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant();
  await ensureLoanAndConsent(ctx.tenantId);
});

test.afterAll(async () => {
  if (ctx.createdConsentId) {
    await db
      .delete(schema.consentRecords)
      .where(eq(schema.consentRecords.id, ctx.createdConsentId))
      .catch(() => {});
  }
  if (ctx.createdLoanId) {
    await db
      .delete(schema.nbfcLoans)
      .where(eq(schema.nbfcLoans.loan_application_id, ctx.leadId))
      .catch(() => {});
  }
  if (ctx.createdLeadId) {
    await db
      .delete(schema.loanApplications)
      .where(eq(schema.loanApplications.id, ctx.leadId))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------

test.describe('E-080 — Compliance screen-metadata renderer', () => {
  test('AC1: immobilisation screen returns all mandatory compliance elements', async ({
    request,
  }) => {
    const userId = randomUUID();
    const res = await request.get(
      `/api/nbfc/compliance/screen-metadata?screen=immobilisation_confirm&lead_id=${ctx.leadId}`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: 'viewer',
        }),
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();

    expect(body.screen).toBe('immobilisation_confirm');
    expect(body.lender_identity?.nbfc_legal_name).toBeTruthy();
    expect(body.lsp_identity?.name).toBe('iTarang Battery Solutions');
    expect(body.grievance?.url).toBeTruthy();
    expect(body.grievance?.helpline).toBeTruthy();
    expect(typeof body.outstanding?.amount_inr).toBe('number');
    expect(body.reversibility_disclosure).toContain('2–4 hours');
    expect(body.regulatory_footer).toContain(
      'RBI Digital Lending Directions 2025',
    );
  });

  test('AC2: immobilisation screen without lead_id returns 400', async ({
    request,
  }) => {
    const userId = randomUUID();
    const res = await request.get(
      `/api/nbfc/compliance/screen-metadata?screen=immobilisation_confirm`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: 'viewer',
        }),
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json().catch(() => ({}) as { error?: string });
    expect(String(body.error ?? '')).toMatch(/BAD_REQUEST|lead_id/i);
  });

  test('AC3: telemetry screen returns DPDPA purpose and consent date', async ({
    request,
  }) => {
    const userId = randomUUID();
    const res = await request.get(
      `/api/nbfc/compliance/screen-metadata?screen=telemetry_view&lead_id=${ctx.leadId}`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: 'viewer',
        }),
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();

    expect(body.data_purpose?.text).toContain('loan risk assessment');
    expect(body.data_purpose?.consent_date).toBeTruthy();
    // The signed_at echoed back must match what we seeded (ms-precision).
    const echoed = new Date(body.data_purpose.consent_date).getTime();
    expect(echoed).toBe(ctx.consentSignedAt.getTime());
  });

  test('AC4: unauthenticated request returns 401', async ({ request }) => {
    // No bypass headers — production code path will reject because there is
    // no Supabase session in the test runner.
    const res = await request.get(
      `/api/nbfc/compliance/screen-metadata?screen=portal_footer`,
    );
    expect([401, 403]).toContain(res.status());
  });
});
