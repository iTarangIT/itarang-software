/**
 * E-008 — Digio webhook handler for NBFC LSP Agreement status updates.
 *
 * AC1: POST /api/digio/webhook/nbfc with callback='NBFC_<id>' and
 *      agreement_status='SIGN_PENDING' updates the matching
 *      nbfc_lsp_agreements row's agreement_status to 'SIGN_PENDING'.
 * AC2: callback that doesn't match /^NBFC_\d+$/ returns 400.
 * AC3: When agreement_status='COMPLETED' arrives, the corresponding
 *      nbfc.lsp_agreement_id is set to the nbfc_lsp_agreements.id.
 * AC4: Replaying the same COMPLETED webhook twice does not regress
 *      agreement_status nor duplicate signed_pdf_url updates.
 *
 * Auth: webhook is public — no auth bypass required.
 * Digio fetch: stubbed via NBFC_DIGIO_STUB=1 + NBFC_TEST_BYPASS_SECRET so
 * the COMPLETED branch's PDF fetch returns a deterministic synthetic URL
 * without contacting Digio or Supabase Storage.
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
  throw new Error('DATABASE_URL must be set for E-008 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = [];

async function insertTestNbfc(suffix: string): Promise<number> {
  const tag = `e008-${suffix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: tag.slice(0, 50),
      legal_name: `E-008 Test NBFC ${tag}`,
      short_name: `E008 ${tag.slice(0, 20)}`,
      rbi_registration_no: tag.slice(0, 100),
      cin: 'U65999MH2026PTC000008',
      gst_number: '27AAACT2728Q1Z7',
      pan_number: 'AAACT2728Q',
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
    await db
      .update(schema.nbfc)
      .set({ lsp_agreement_id: null })
      .where(eq(schema.nbfc.id, row.id));
    await db
      .delete(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.nbfc_id, row.id));
    await db.delete(schema.nbfc).where(eq(schema.nbfc.id, row.id));
  });
  return row.id;
}

async function insertAgreementRow(nbfcId: number, suffix: string): Promise<{
  id: number;
  agreement_id: string;
}> {
  // agreement_id pattern matches the E-007 generator (AGR-NBFC-YYYYMMDD-NNNN)
  // so any downstream regex assertions remain happy.
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = Math.floor(Math.random() * 9000) + 1000;
  const agreementId = `AGR-NBFC-${ymd}-${seq}-${suffix}`;
  const [row] = await db
    .insert(schema.nbfcLspAgreements)
    .values({
      agreement_id: agreementId,
      nbfc_id: nbfcId,
      digio_document_id: `DIGIO-STUB-${suffix}-${Date.now().toString(36)}`,
      digio_request_id: `DIGIO-STUB-${suffix}-${Date.now().toString(36)}`,
      agreement_status: 'SENT_TO_EXTERNAL_PARTY',
      nbfc_signatory_name: 'NBFC Sig',
      nbfc_signatory_email: 'nbfc-sig@example.com',
      itarang_signatory_1_name: 'iTarang One',
      itarang_signatory_1_email: 'it1@example.com',
      itarang_signatory_2_name: 'iTarang Two',
      itarang_signatory_2_email: 'it2@example.com',
      initiated_at: new Date(),
      expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      last_webhook_payload: { init_request: { stub: true } },
    })
    .returning({ id: schema.nbfcLspAgreements.id, agreement_id: schema.nbfcLspAgreements.agreement_id });
  return { id: row.id, agreement_id: row.agreement_id! };
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

test.describe('E-008 — NBFC LSP agreement webhook', () => {
  test('AC1: NBFC_<id> callback updates agreement_status to SIGN_PENDING', async ({ request }) => {
    const nbfcId = await insertTestNbfc('ac1');
    const { id: rowId, agreement_id } = await insertAgreementRow(nbfcId, 'ac1');

    const res = await request.post('/api/digio/webhook/nbfc', {
      data: {
        payload: {
          agreement_id,
          agreement_status: 'SIGN_PENDING',
          callback: `NBFC_${nbfcId}`,
        },
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agreement_status).toBe('SIGN_PENDING');

    const [row] = await db
      .select({ agreement_status: schema.nbfcLspAgreements.agreement_status })
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.id, rowId));
    expect(row.agreement_status).toBe('SIGN_PENDING');
  });

  test('AC2: non-NBFC callback returns 400', async ({ request }) => {
    const res = await request.post('/api/digio/webhook/nbfc', {
      data: {
        payload: {
          agreement_id: 'AGR-NBFC-19700101-0001',
          agreement_status: 'SIGN_PENDING',
          // dealer-flow callback prefix — must be rejected at the routing layer.
          callback: 'DEALER_42',
        },
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('INVALID_CALLBACK_PREFIX');
  });

  test('AC3: COMPLETED webhook backfills nbfc.lsp_agreement_id', async ({ request }) => {
    const nbfcId = await insertTestNbfc('ac3');
    const { id: rowId, agreement_id } = await insertAgreementRow(nbfcId, 'ac3');

    const res = await request.post('/api/digio/webhook/nbfc', {
      data: {
        payload: {
          agreement_id,
          agreement_status: 'COMPLETED',
          callback: `NBFC_${nbfcId}`,
        },
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.backfilled_nbfc_lsp_agreement_id).toBe(true);

    const [agr] = await db
      .select({
        agreement_status: schema.nbfcLspAgreements.agreement_status,
        signed_pdf_url: schema.nbfcLspAgreements.signed_pdf_url,
        audit_trail_url: schema.nbfcLspAgreements.audit_trail_url,
        signing_date: schema.nbfcLspAgreements.signing_date,
      })
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.id, rowId));
    expect(agr.agreement_status).toBe('COMPLETED');
    expect(agr.signed_pdf_url).toBeTruthy();
    expect(agr.audit_trail_url).toBeTruthy();
    expect(agr.signing_date).toBeTruthy();

    const [nbfcRow] = await db
      .select({ lsp_agreement_id: schema.nbfc.lsp_agreement_id })
      .from(schema.nbfc)
      .where(eq(schema.nbfc.id, nbfcId));
    expect(nbfcRow.lsp_agreement_id).toBe(rowId);
  });

  test('AC4: replaying COMPLETED is idempotent (no regression, no duplicate URL writes)', async ({ request }) => {
    const nbfcId = await insertTestNbfc('ac4');
    const { id: rowId, agreement_id } = await insertAgreementRow(nbfcId, 'ac4');

    // First COMPLETED.
    const first = await request.post('/api/digio/webhook/nbfc', {
      data: {
        payload: {
          agreement_id,
          agreement_status: 'COMPLETED',
          callback: `NBFC_${nbfcId}`,
        },
      },
    });
    expect(first.status()).toBe(200);

    const [afterFirst] = await db
      .select({
        agreement_status: schema.nbfcLspAgreements.agreement_status,
        signed_pdf_url: schema.nbfcLspAgreements.signed_pdf_url,
        audit_trail_url: schema.nbfcLspAgreements.audit_trail_url,
        signing_date: schema.nbfcLspAgreements.signing_date,
      })
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.id, rowId));
    expect(afterFirst.agreement_status).toBe('COMPLETED');
    const firstSignedUrl = afterFirst.signed_pdf_url;
    expect(firstSignedUrl).toBeTruthy();

    // Replay the same COMPLETED — must be idempotent.
    const second = await request.post('/api/digio/webhook/nbfc', {
      data: {
        payload: {
          agreement_id,
          agreement_status: 'COMPLETED',
          callback: `NBFC_${nbfcId}`,
        },
      },
    });
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.idempotent).toBe(true);

    const [afterSecond] = await db
      .select({
        agreement_status: schema.nbfcLspAgreements.agreement_status,
        signed_pdf_url: schema.nbfcLspAgreements.signed_pdf_url,
        audit_trail_url: schema.nbfcLspAgreements.audit_trail_url,
        signing_date: schema.nbfcLspAgreements.signing_date,
      })
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.id, rowId));
    // Status unchanged.
    expect(afterSecond.agreement_status).toBe('COMPLETED');
    // signed_pdf_url unchanged — exact same string from first invocation.
    expect(afterSecond.signed_pdf_url).toBe(firstSignedUrl);
    expect(afterSecond.audit_trail_url).toBe(afterFirst.audit_trail_url);
    expect(afterSecond.signing_date).toBe(afterFirst.signing_date);

    // Also: an earlier-stage replay (SIGN_PENDING) must not regress COMPLETED.
    const regressionRes = await request.post('/api/digio/webhook/nbfc', {
      data: {
        payload: {
          agreement_id,
          agreement_status: 'SIGN_PENDING',
          callback: `NBFC_${nbfcId}`,
        },
      },
    });
    expect(regressionRes.status()).toBe(200);
    const regressionBody = await regressionRes.json();
    expect(regressionBody.idempotent).toBe(true);

    const [afterRegression] = await db
      .select({ agreement_status: schema.nbfcLspAgreements.agreement_status })
      .from(schema.nbfcLspAgreements)
      .where(eq(schema.nbfcLspAgreements.id, rowId));
    expect(afterRegression.agreement_status).toBe('COMPLETED');
  });
});
