/**
 * E-001 — NBFC final approval gate API tests.
 *
 * AC1: POST /approve returns 422 when any required compliance document is
 *      missing or unverified.
 * AC2: POST /approve returns 422 when nbfc_lsp_agreements.agreement_status
 *      != 'COMPLETED'.
 * AC3: All gates open → POST returns 200 and DB shows nbfc.status='approved'.
 * AC4: UI test — Approve button disabled with the BRD-mandated tooltip when
 *      readiness API returns canApprove=false. (component-level via mocked
 *      fetcher; route-mounted because the component is "use client").
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
import { REQUIRED_NBFC_DOC_TYPES } from '../../../src/lib/nbfc/admin/required-docs';

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-001 API tests');
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
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = [];

/**
 * Insert a minimal NBFC row in 'pending_review' status. The `nbfc` table has
 * many NOT-NULL columns from the master CRUD form (E-003); we fill them with
 * synthetic values keyed off the test run so we don't collide on the unique
 * (nbfc_id, rbi_registration_no) constraints.
 */
async function insertTestNbfc(suffix: string): Promise<number> {
  const tag = `e001-${suffix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: tag.slice(0, 50),
      legal_name: `E-001 Test NBFC ${tag}`,
      short_name: `E001 ${tag.slice(0, 20)}`,
      rbi_registration_no: tag.slice(0, 100),
      cin: 'U65999MH2026PTC000001',
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
    await db.delete(schema.nbfcLspAgreements).where(eq(schema.nbfcLspAgreements.nbfc_id, row.id));
    await db.delete(schema.nbfcComplianceDocuments).where(eq(schema.nbfcComplianceDocuments.nbfc_id, row.id));
    await db.delete(schema.nbfc).where(eq(schema.nbfc.id, row.id));
  });
  return row.id;
}

async function insertVerifiedDocs(nbfcId: number, types: readonly string[]) {
  if (types.length === 0) return;
  await db.insert(schema.nbfcComplianceDocuments).values(
    types.map((t) => ({
      nbfc_id: nbfcId,
      document_type: t,
      file_url: `https://example.com/${t}.pdf`,
      status: 'verified',
      uploaded_by: 1,
      verified_by: 1,
      verified_at: new Date(),
    })),
  );
}

async function insertLspAgreement(nbfcId: number, status: string) {
  await db.insert(schema.nbfcLspAgreements).values({
    nbfc_id: nbfcId,
    agreement_status: status,
  });
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

test.describe('E-001 — NBFC final approval gate', () => {
  test('AC1: approve blocked when required docs unverified', async ({ request }) => {
    const id = await insertTestNbfc('ac1');
    // LSP COMPLETED but only some docs verified — gate must still close.
    await insertLspAgreement(id, 'COMPLETED');
    await insertVerifiedDocs(id, REQUIRED_NBFC_DOC_TYPES.slice(0, 3));

    const res = await request.post(`/api/admin/nbfc/${id}/approve`, {
      headers: adminBypassHeaders(),
      data: {},
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(422);
    const body = await res.json();
    expect(Array.isArray(body.missingDocs)).toBe(true);
    expect(body.missingDocs.length).toBeGreaterThan(0);
    // Must still be in pending_review.
    const [row] = await db.select({ status: schema.nbfc.status }).from(schema.nbfc).where(eq(schema.nbfc.id, id));
    expect(row.status).toBe('pending_review');
  });

  test('AC2: approve blocked when LSP agreement not COMPLETED', async ({ request }) => {
    const id = await insertTestNbfc('ac2');
    // All docs verified, but LSP is still IN_PROGRESS.
    await insertVerifiedDocs(id, REQUIRED_NBFC_DOC_TYPES);
    await insertLspAgreement(id, 'IN_PROGRESS');

    const res = await request.post(`/api/admin/nbfc/${id}/approve`, {
      headers: adminBypassHeaders(),
      data: {},
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(422);
    const body = await res.json();
    expect(body.lspAgreementStatus).toBe('IN_PROGRESS');
    expect(body.missingDocs).toEqual([]);
    expect(String(body.reason)).toMatch(/LSP Agreement/i);
  });

  test('AC3: approve succeeds and persists status=approved', async ({ request }) => {
    const id = await insertTestNbfc('ac3');
    await insertVerifiedDocs(id, REQUIRED_NBFC_DOC_TYPES);
    await insertLspAgreement(id, 'COMPLETED');

    const adminId = randomUUID();
    const res = await request.post(`/api/admin/nbfc/${id}/approve`, {
      headers: adminBypassHeaders({ userId: adminId, role: 'admin' }),
      data: { notes: 'all docs reviewed and verified' },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('approved');
    expect(body.nbfcId).toBe(id);
    expect(body.approvedAt).toBeTruthy();

    // DB check.
    const [row] = await db
      .select({ status: schema.nbfc.status, approved_by: schema.nbfc.approved_by, approved_at: schema.nbfc.approved_at })
      .from(schema.nbfc)
      .where(eq(schema.nbfc.id, id));
    expect(row.status).toBe('approved');
    expect(row.approved_by).toBe(adminId);
    expect(row.approved_at).toBeTruthy();

    // Idempotency — re-approval returns 409.
    const res2 = await request.post(`/api/admin/nbfc/${id}/approve`, {
      headers: adminBypassHeaders({ userId: adminId, role: 'admin' }),
      data: {},
    });
    expect(res2.status()).toBe(409);
  });

  test('AC4: review page disables Approve and shows BRD tooltip when not ready', async ({ page }) => {
    const id = await insertTestNbfc('ac4');
    // LSP not COMPLETED → not ready.
    await insertLspAgreement(id, 'IN_PROGRESS');

    // Attach the bypass header to every request the browser sends so middleware
    // skips Supabase auth and serves the protected /admin/nbfc/.../review page.
    await page.setExtraHTTPHeaders({
      'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
      'x-nbfc-test-user-id': randomUUID(),
      'x-nbfc-test-user-role': 'admin',
    });

    // Stub the readiness fetch so the page renders the not-ready state.
    await page.route(`**/api/admin/nbfc/${id}/approval-readiness`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          canApprove: false,
          missingDocs: ['rbi_cor'],
          lspAgreementStatus: 'IN_PROGRESS',
          reason:
            'Cannot activate until LSP Agreement is fully signed and downloaded from Digio.',
        }),
      });
    });

    await page.goto(`/admin/nbfc/${id}/review`);
    const button = page.getByTestId('approve-button');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute(
      'title',
      'Cannot activate until LSP Agreement is fully signed and downloaded from Digio.',
    );
  });
});
