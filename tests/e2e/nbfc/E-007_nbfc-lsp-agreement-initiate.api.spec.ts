/**
 * E-007 — NBFC LSP Agreement initiate API tests.
 *
 * AC1: POST /lsp-agreement/initiate calls Digio create_sign_request with
 *      sequential=true and callback='NBFC_'+nbfcId. (Asserted via the
 *      persisted last_webhook_payload jsonb which captures the outgoing
 *      Digio payload + endpoint path.)
 * AC2: nbfc_lsp_agreements row inserted with agreement_status =
 *      'SENT_TO_EXTERNAL_PARTY' and agreement_id matching
 *      /^AGR-NBFC-\d{8}-\d+$/.
 * AC3: Digio payload signer order is [NBFC, iTarang1, iTarang2].
 * AC4: expires_at = initiated_at + expire_in_days days (default 5).
 *
 * Auth: triple-guarded admin test bypass.
 * Digio: stubbed via NBFC_DIGIO_STUB=1 + NBFC_TEST_BYPASS_SECRET (the dev
 * server inherits these via the loop's run_tests.sh env propagation).
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
  throw new Error('DATABASE_URL must be set for E-007 API tests');
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

async function insertTestNbfc(suffix: string): Promise<number> {
  const tag = `e007-${suffix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: tag.slice(0, 50),
      legal_name: `E-007 Test NBFC ${tag}`,
      short_name: `E007 ${tag.slice(0, 20)}`,
      rbi_registration_no: tag.slice(0, 100),
      cin: 'U65999MH2026PTC000007',
      gst_number: '27AAACT2727Q1Z7',
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
    await db.delete(schema.nbfc).where(eq(schema.nbfc.id, row.id));
  });
  return row.id;
}

const VALID_BODY = () => ({
  nbfcSignatoryName: 'NBFC Sig',
  nbfcSignatoryEmail: 'nbfc-sig@example.com',
  itarangSignatory1Name: 'iTarang One',
  itarangSignatory1Email: 'it1@example.com',
  itarangSignatory2Name: 'iTarang Two',
  itarangSignatory2Email: 'it2@example.com',
});

test.afterAll(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------

test.describe('E-007 — NBFC LSP agreement initiate', () => {
  test('AC1: Digio request uses sequential=true and NBFC callback', async ({ request }) => {
    const id = await insertTestNbfc('ac1');

    const res = await request.post(
      `/api/admin/nbfc/${id}/lsp-agreement/initiate`,
      {
        headers: adminBypassHeaders(),
        data: VALID_BODY(),
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.callback).toBe(`NBFC_${id}`);
    expect(body.sequential).toBe(true);

    // Inspect the persisted outgoing Digio payload.
    const [row] = await db
      .select({ last_webhook_payload: schema.nbfcLspAgreements.last_webhook_payload })
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.nbfc_id, id));
    expect(row).toBeTruthy();
    const payload = row.last_webhook_payload as { init_request?: { sequential?: boolean; callback?: string } };
    expect(payload?.init_request?.sequential).toBe(true);
    expect(payload?.init_request?.callback).toBe(`NBFC_${id}`);
  });

  test('AC2: agreement row persisted with SENT_TO_EXTERNAL_PARTY and agreement_id pattern', async ({ request }) => {
    const id = await insertTestNbfc('ac2');
    const res = await request.post(
      `/api/admin/nbfc/${id}/lsp-agreement/initiate`,
      {
        headers: adminBypassHeaders(),
        data: VALID_BODY(),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.agreementStatus).toBe('SENT_TO_EXTERNAL_PARTY');
    expect(body.agreementId).toMatch(/^AGR-NBFC-\d{8}-\d+$/);

    const [row] = await db
      .select()
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.nbfc_id, id));
    expect(row.agreement_status).toBe('SENT_TO_EXTERNAL_PARTY');
    expect(row.agreement_id).toMatch(/^AGR-NBFC-\d{8}-\d+$/);
    expect(row.digio_document_id).toBeTruthy();
  });

  test('AC3: signer order is NBFC -> iTarang1 -> iTarang2', async ({ request }) => {
    const id = await insertTestNbfc('ac3');
    const body = VALID_BODY();
    const res = await request.post(
      `/api/admin/nbfc/${id}/lsp-agreement/initiate`,
      {
        headers: adminBypassHeaders(),
        data: body,
      },
    );
    expect(res.status()).toBe(200);
    const responseBody = await res.json();
    expect(responseBody.signerCount).toBe(3);
    expect(responseBody.signerOrder).toEqual([
      body.nbfcSignatoryEmail,
      body.itarangSignatory1Email,
      body.itarangSignatory2Email,
    ]);

    // Inspect the persisted Digio payload's signers array — sequential=true
    // means index 0 signs first.
    const [row] = await db
      .select({ last_webhook_payload: schema.nbfcLspAgreements.last_webhook_payload })
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.nbfc_id, id));
    const payload = row.last_webhook_payload as {
      init_request?: { signers?: Array<{ identifier: string; name: string }> };
    };
    const signers = payload?.init_request?.signers ?? [];
    expect(signers).toHaveLength(3);
    expect(signers[0]?.identifier).toBe(body.nbfcSignatoryEmail);
    expect(signers[1]?.identifier).toBe(body.itarangSignatory1Email);
    expect(signers[2]?.identifier).toBe(body.itarangSignatory2Email);
  });

  test('AC4: expires_at honors expire_in_days setting (default 5)', async ({ request }) => {
    const id = await insertTestNbfc('ac4');
    const before = Date.now();
    const res = await request.post(
      `/api/admin/nbfc/${id}/lsp-agreement/initiate`,
      {
        headers: adminBypassHeaders(),
        data: VALID_BODY(),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const after = Date.now();

    expect(body.expireInDays).toBe(5);

    const [row] = await db
      .select({
        expires_at: schema.nbfcLspAgreements.expires_at,
        initiated_at: schema.nbfcLspAgreements.initiated_at,
      })
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.nbfc_id, id));
    expect(row.expires_at).toBeTruthy();
    expect(row.initiated_at).toBeTruthy();
    const expiresMs = new Date(row.expires_at as Date).getTime();
    const initiatedMs = new Date(row.initiated_at as Date).getTime();
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    // expires_at - initiated_at == 5 days exactly (within ms), and both
    // timestamps fall within the request window.
    expect(expiresMs - initiatedMs).toBe(fiveDaysMs);
    expect(initiatedMs).toBeGreaterThanOrEqual(before - 5_000);
    expect(initiatedMs).toBeLessThanOrEqual(after + 5_000);
  });
});
