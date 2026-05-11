/**
 * E-011 — NBFC status lifecycle API tests.
 *
 * AC1: POST /transition with to='pending_admin_review' from current
 *      status='draft' returns 200 and updates nbfc.status.
 * AC2: POST /transition from current status='rejected' to any other status
 *      returns 409 (terminal).
 * AC3: POST with to='rejected' and empty reason returns 422; with non-empty
 *      reason returns 200.
 * AC4: Every successful transition inserts one row in nbfc_status_history
 *      with from_status, to_status, actor_id matching the request.
 *
 * Auth: triple-guarded admin test bypass (mirrors E-001 spec).
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-011 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function adminBypassHeaders(opts?: { userId?: string; role?: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-user-id': opts?.userId ?? randomUUID(),
    'x-nbfc-test-user-role': opts?.role ?? 'admin',
  };
}

const cleanup: Array<() => Promise<void>> = [];

async function insertTestNbfc(suffix: string, status = 'draft'): Promise<number> {
  const tag = `e011-${suffix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: tag.slice(0, 50),
      legal_name: `E-011 Test NBFC ${tag}`,
      short_name: `E011 ${tag.slice(0, 20)}`,
      rbi_registration_no: tag.slice(0, 100),
      cin: 'U65999MH2026PTC000011',
      gst_number: '27AAACT2727Q1Z0',
      pan_number: 'AAACT2727Q',
      nbfc_type: 'NBFC-ICC',
      registered_address: { line1: 'Test', city: 'Mumbai' },
      active_geographies: { states: ['MH'] },
      primary_contact_name: 'Test Contact',
      primary_contact_email: `${tag}@example.com`,
      primary_contact_phone: '+919999999999',
      grievance_officer_name: 'Test Officer',
      grievance_helpline: '1800-000-000',
      grievance_url: 'https://example.com/grievance',
      partnership_date: '2026-01-01',
      status,
      created_by: 1,
    })
    .returning({ id: schema.nbfc.id });
  cleanup.push(async () => {
    await db.delete(schema.nbfcStatusHistory).where(eq(schema.nbfcStatusHistory.nbfc_id, row.id));
    await db.delete(schema.nbfc).where(eq(schema.nbfc.id, row.id));
  });
  return row.id;
}

test.afterAll(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-011 — NBFC status lifecycle', () => {
  test('AC1: draft → pending_admin_review allowed', async ({ request }) => {
    const id = await insertTestNbfc('ac1', 'draft');
    const res = await request.post(`/api/admin/nbfc/${id}/transition`, {
      headers: adminBypassHeaders(),
      data: { to: 'pending_admin_review' },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.from).toBe('draft');
    expect(body.to).toBe('pending_admin_review');

    const [row] = await db
      .select({ status: schema.nbfc.status })
      .from(schema.nbfc)
      .where(eq(schema.nbfc.id, id));
    expect(row.status).toBe('pending_admin_review');
  });

  test('AC2: rejected is terminal', async ({ request }) => {
    const id = await insertTestNbfc('ac2', 'rejected');
    for (const target of [
      'draft',
      'pending_admin_review',
      'approved',
      'active',
      'suspended',
      'terminated',
    ]) {
      const res = await request.post(`/api/admin/nbfc/${id}/transition`, {
        headers: adminBypassHeaders(),
        data: { to: target, reason: 'attempt to revive' },
      });
      expect(res.status(), `target=${target}`).toBe(409);
    }
  });

  test('AC3: rejection requires reason', async ({ request }) => {
    const id = await insertTestNbfc('ac3', 'pending_admin_review');

    // Empty reason → 422
    const resEmpty = await request.post(`/api/admin/nbfc/${id}/transition`, {
      headers: adminBypassHeaders(),
      data: { to: 'rejected' },
    });
    expect(resEmpty.status()).toBe(422);

    const resBlank = await request.post(`/api/admin/nbfc/${id}/transition`, {
      headers: adminBypassHeaders(),
      data: { to: 'rejected', reason: '   ' },
    });
    expect(resBlank.status()).toBe(422);

    // Non-empty reason → 200
    const resOk = await request.post(`/api/admin/nbfc/${id}/transition`, {
      headers: adminBypassHeaders(),
      data: { to: 'rejected', reason: 'Failed AML/KYC checks' },
    });
    expect(resOk.status(), await resOk.text().catch(() => '')).toBe(200);

    const [row] = await db
      .select({ status: schema.nbfc.status })
      .from(schema.nbfc)
      .where(eq(schema.nbfc.id, id));
    expect(row.status).toBe('rejected');
  });

  test('AC4: every successful transition is recorded in history', async ({ request }) => {
    const id = await insertTestNbfc('ac4', 'draft');
    const adminId = randomUUID();
    const headers = adminBypassHeaders({ userId: adminId, role: 'admin' });

    // draft → pending_admin_review
    let res = await request.post(`/api/admin/nbfc/${id}/transition`, {
      headers,
      data: { to: 'pending_admin_review', reason: 'submitting' },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);

    // pending_admin_review → request_correction
    res = await request.post(`/api/admin/nbfc/${id}/transition`, {
      headers,
      data: { to: 'request_correction', reason: 'fix CIN' },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);

    // GET history endpoint
    const hres = await request.get(`/api/admin/nbfc/${id}/status-history`, {
      headers,
    });
    expect(hres.status()).toBe(200);
    const hbody = await hres.json();
    expect(hbody.ok).toBe(true);
    expect(Array.isArray(hbody.items)).toBe(true);
    expect(hbody.items.length).toBe(2);

    const [first, second] = hbody.items;
    expect(first.fromStatus).toBe('draft');
    expect(first.toStatus).toBe('pending_admin_review');
    expect(first.actorId).toBe(adminId);
    expect(first.reason).toBe('submitting');

    expect(second.fromStatus).toBe('pending_admin_review');
    expect(second.toStatus).toBe('request_correction');
    expect(second.actorId).toBe(adminId);
    expect(second.reason).toBe('fix CIN');

    // Cross-check via direct DB query.
    const dbRows = await db
      .select()
      .from(schema.nbfcStatusHistory)
      .where(eq(schema.nbfcStatusHistory.nbfc_id, id));
    expect(dbRows.length).toBe(2);
  });
});
