/**
 * E-005 — NBFC compliance document upload, verify, reject workflow.
 *
 * Each AC is one Playwright test. Routes are auth-gated; we use the
 * triple-guarded test bypass (NODE_ENV != production AND NBFC_TEST_BYPASS_SECRET
 * set on server AND `x-nbfc-test-bypass` header on request) plus a fabricated
 * admin numeric id via `x-nbfc-test-admin-id`.
 *
 * AC1: POST /compliance-documents with valid documentType+fileUrl returns 200,
 *      inserts a row with status='pending_review'.
 * AC2: POST with documentType='rbi_cor' and missing expiryDate returns 422.
 * AC3: PATCH /verify on a pending document sets status='verified' and persists
 *      verified_at and verified_by.
 * AC4: PATCH /reject with empty rejectionReason returns 422; with non-empty
 *      reason sets status='rejected' and stores the reason.
 */
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
  throw new Error('DATABASE_URL must be set for E-005 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Test bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function adminBypassHeaders(adminId: number, role = 'admin') {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-admin-id': String(adminId),
    'x-nbfc-test-admin-role': role,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ctx: { nbfcId: number } = { nbfcId: 0 };
const createdDocIds = new Set<number>();
const ADMIN_NUMERIC_ID = 90005; // arbitrary, scoped to E-005 test runs

async function getOrCreateNbfc(): Promise<number> {
  // Try to find any existing nbfc row first; fall back to insert.
  const existing = await db.select().from(schema.nbfc).limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: `NBFC-E005-${Date.now()}`,
      legal_name: 'E-005 Test NBFC',
      status: 'draft',
    })
    .returning();
  return row.id;
}

test.beforeAll(async () => {
  ctx.nbfcId = await getOrCreateNbfc();
});

test.afterAll(async () => {
  for (const id of createdDocIds) {
    await db
      .delete(schema.nbfcComplianceDocuments)
      .where(eq(schema.nbfcComplianceDocuments.id, id))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe('E-005 — NBFC compliance document workflow', () => {
  test('AC1: upload creates pending_review document row', async ({ request }) => {
    const res = await request.post(
      `/api/admin/nbfc/${ctx.nbfcId}/compliance-documents`,
      {
        headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
        data: {
          documentType: 'certificate_of_incorporation',
          fileUrl: 'https://example.test/files/coi.pdf',
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('pending_review');
    expect(body.document_type).toBe('certificate_of_incorporation');
    expect(body.nbfc_id).toBe(ctx.nbfcId);
    createdDocIds.add(body.id);

    const rows = await db
      .select()
      .from(schema.nbfcComplianceDocuments)
      .where(eq(schema.nbfcComplianceDocuments.id, body.id))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending_review');
    expect(rows[0].uploaded_by).toBe(ADMIN_NUMERIC_ID);
  });

  test('AC2: RBI CoR upload requires expiry_date', async ({ request }) => {
    // Missing expiryDate → 422
    const missing = await request.post(
      `/api/admin/nbfc/${ctx.nbfcId}/compliance-documents`,
      {
        headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
        data: {
          documentType: 'rbi_cor',
          fileUrl: 'https://example.test/files/rbi-cor.pdf',
        },
      },
    );
    expect(missing.status()).toBe(422);

    // With expiryDate → 200 and nbfc.cor_expiry_date is mirrored.
    const withExpiry = await request.post(
      `/api/admin/nbfc/${ctx.nbfcId}/compliance-documents`,
      {
        headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
        data: {
          documentType: 'rbi_cor',
          fileUrl: 'https://example.test/files/rbi-cor.pdf',
          expiryDate: '2030-12-31',
        },
      },
    );
    expect(withExpiry.status(), await withExpiry.text().catch(() => '')).toBe(200);
    const body = await withExpiry.json();
    createdDocIds.add(body.id);

    const nbfcRow = await db
      .select({ cor_expiry_date: schema.nbfc.cor_expiry_date })
      .from(schema.nbfc)
      .where(eq(schema.nbfc.id, ctx.nbfcId))
      .limit(1);
    expect(String(nbfcRow[0].cor_expiry_date)).toContain('2030-12-31');
  });

  test('AC3: verify transitions doc to verified', async ({ request }) => {
    const create = await request.post(
      `/api/admin/nbfc/${ctx.nbfcId}/compliance-documents`,
      {
        headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
        data: {
          documentType: 'pan_card_company',
          fileUrl: 'https://example.test/files/pan.pdf',
        },
      },
    );
    expect(create.status()).toBe(200);
    const created = await create.json();
    createdDocIds.add(created.id);

    const verifierId = ADMIN_NUMERIC_ID + 1;
    const verify = await request.patch(
      `/api/admin/nbfc/compliance-documents/${created.id}/verify`,
      {
        headers: adminBypassHeaders(verifierId),
        data: { verifierNotes: 'PAN reviewed' },
      },
    );
    expect(verify.status(), await verify.text().catch(() => '')).toBe(200);
    const verified = await verify.json();
    expect(verified.status).toBe('verified');
    expect(verified.verified_by).toBe(verifierId);
    expect(verified.verified_at).toBeTruthy();

    const row = await db
      .select()
      .from(schema.nbfcComplianceDocuments)
      .where(eq(schema.nbfcComplianceDocuments.id, created.id))
      .limit(1);
    expect(row[0].status).toBe('verified');
    expect(row[0].verified_by).toBe(verifierId);
    expect(row[0].verified_at).not.toBeNull();
  });

  test('AC4: reject requires rejection reason', async ({ request }) => {
    const create = await request.post(
      `/api/admin/nbfc/${ctx.nbfcId}/compliance-documents`,
      {
        headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
        data: {
          documentType: 'gst_registration',
          fileUrl: 'https://example.test/files/gst.pdf',
        },
      },
    );
    expect(create.status()).toBe(200);
    const created = await create.json();
    createdDocIds.add(created.id);

    // Empty reason -> 422
    const reject1 = await request.patch(
      `/api/admin/nbfc/compliance-documents/${created.id}/reject`,
      {
        headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
        data: { rejectionReason: '' },
      },
    );
    expect(reject1.status()).toBe(422);

    // Valid reason -> 200
    const rejecterId = ADMIN_NUMERIC_ID + 2;
    const reject2 = await request.patch(
      `/api/admin/nbfc/compliance-documents/${created.id}/reject`,
      {
        headers: adminBypassHeaders(rejecterId),
        data: { rejectionReason: 'GSTIN does not match PAN' },
      },
    );
    expect(reject2.status(), await reject2.text().catch(() => '')).toBe(200);
    const rejected = await reject2.json();
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('GSTIN does not match PAN');

    const row = await db
      .select()
      .from(schema.nbfcComplianceDocuments)
      .where(eq(schema.nbfcComplianceDocuments.id, created.id))
      .limit(1);
    expect(row[0].status).toBe('rejected');
    expect(row[0].rejection_reason).toBe('GSTIN does not match PAN');
    expect(row[0].rejected_by).toBe(rejecterId);
  });
});
