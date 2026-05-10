/**
 * E-071 — Admin Audit Log query API with filters and tenant scoping (BRD §6.3.5).
 *
 * AC1: Admin JWT sees rows from all NBFCs in audit log.
 * AC2: NBFC JWT only sees its own NBFC audit rows.
 * AC3: Action filter restricts results to that action code.
 * AC4: Date range filter restricts rows to the inclusive window.
 * AC5: Status filter returns only matching exec_status rows.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error('DATABASE_URL must be set for E-071 API tests');
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function adminBypassHeaders(adminId: string) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-admin-id': adminId,
    'x-nbfc-test-admin-role': 'admin',
  };
}

function nbfcBypassHeaders(opts: { tenantId: string; userId: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-tenant-id': opts.tenantId,
    'x-nbfc-test-user-id': opts.userId,
    'x-nbfc-test-user-role': 'viewer',
  };
}

const SUITE = `e071-${Date.now()}`;
const ENTITY_PREFIX = `${SUITE}-`;
const ACTION_TAG = `E071_TEST_${Date.now()}`;
const seededLogIds: string[] = [];
let tenantA = '';
let tenantB = '';
let userIdAdmin = '';
let userIdNbfcA = '';

async function getOrCreateTenant(slug: string): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.slug, slug))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-071 Test NBFC ${slug}` })
    .returning();
  return row.id;
}

type SeededLog = {
  id: string;
  entity_id: string;
  action: string;
  performed_by: string;
  approved_by: string | null;
  exec_status: 'executed' | 'pending' | 'rejected';
  tenant_id: string | null;
  reason_code: string;
  timestamp: Date;
};

async function insertLog(opts: SeededLog): Promise<void> {
  await db.insert(schema.auditLogs).values({
    id: opts.id,
    entity_type: opts.tenant_id ? 'nbfc_action' : 'system',
    entity_id: opts.entity_id,
    action: opts.action,
    performed_by: opts.performed_by,
    new_data: {
      tenant_id: opts.tenant_id,
      approved_by: opts.approved_by,
      exec_status: opts.exec_status,
      reason_code: opts.reason_code,
    },
    timestamp: opts.timestamp,
    created_at: opts.timestamp,
  });
  seededLogIds.push(opts.id);
}

test.beforeAll(async () => {
  tenantA = await getOrCreateTenant(`${SUITE}-a`);
  tenantB = await getOrCreateTenant(`${SUITE}-b`);
  userIdAdmin = randomUUID();
  userIdNbfcA = randomUUID();

  // Seed two rows per tenant + one across-action variety so filters bite.
  const now = Date.now();
  const isoLong = new Date(now - 7 * 24 * 60 * 60 * 1000); // 7d ago
  const isoMid = new Date(now - 1 * 60 * 60 * 1000); // 1h ago
  // a-3 sits OUTSIDE the AC4 window: AC4 uses [2h ago, 30s ago]; we put a-3
  // 1s in the future so date-range tests can assert exclusion.
  const isoRecent = new Date(now + 1000); // 1s in the future

  // Tenant A — IMMOBILIZATION_REQUESTED, executed
  await insertLog({
    id: `${ENTITY_PREFIX}a-1`,
    entity_id: `${ENTITY_PREFIX}BAT-A1`,
    action: ACTION_TAG,
    performed_by: userIdNbfcA,
    approved_by: null,
    exec_status: 'executed',
    tenant_id: tenantA,
    reason_code: 'EMI_OVERDUE',
    timestamp: isoMid,
  });
  // Tenant A — different action, pending
  await insertLog({
    id: `${ENTITY_PREFIX}a-2`,
    entity_id: `${ENTITY_PREFIX}BAT-A2`,
    action: `${ACTION_TAG}_OTHER`,
    performed_by: userIdNbfcA,
    approved_by: null,
    exec_status: 'pending',
    tenant_id: tenantA,
    reason_code: 'EMI_OVERDUE',
    timestamp: isoLong,
  });
  // Tenant A — recent, rejected (for status filter)
  await insertLog({
    id: `${ENTITY_PREFIX}a-3`,
    entity_id: `${ENTITY_PREFIX}BAT-A3`,
    action: `${ACTION_TAG}_OTHER`,
    performed_by: userIdNbfcA,
    approved_by: null,
    exec_status: 'rejected',
    tenant_id: tenantA,
    reason_code: 'GEO_SHIFT',
    timestamp: isoRecent,
  });
  // Tenant B — IMMOBILIZATION_REQUESTED, executed (admin should see, nbfcA should NOT)
  await insertLog({
    id: `${ENTITY_PREFIX}b-1`,
    entity_id: `${ENTITY_PREFIX}BAT-B1`,
    action: ACTION_TAG,
    performed_by: randomUUID(),
    approved_by: null,
    exec_status: 'executed',
    tenant_id: tenantB,
    reason_code: 'EMI_OVERDUE',
    timestamp: isoMid,
  });
});

test.afterAll(async () => {
  if (seededLogIds.length > 0) {
    await db
      .delete(schema.auditLogs)
      .where(inArray(schema.auditLogs.id, seededLogIds));
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-071 — Admin Audit Log query', () => {
  test('AC1: Admin JWT sees rows from all NBFCs in audit log', async ({
    request,
  }) => {
    const res = await request.get(
      `/api/audit-log?action=${ACTION_TAG}&page_size=200`,
      {
        headers: adminBypassHeaders(userIdAdmin),
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    const ids = (body.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(`${ENTITY_PREFIX}a-1`);
    expect(ids).toContain(`${ENTITY_PREFIX}b-1`);
    // total includes our seeded admin-visible rows
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.page).toBe(1);
  });

  test("AC2: NBFC JWT only sees its own NBFC audit rows", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/audit-log?action=${ACTION_TAG}&page_size=200`,
      {
        headers: nbfcBypassHeaders({
          tenantId: tenantA,
          userId: userIdNbfcA,
        }),
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    const ids = (body.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(`${ENTITY_PREFIX}a-1`);
    // Tenant B row must NOT be visible
    expect(ids).not.toContain(`${ENTITY_PREFIX}b-1`);
  });

  test("AC3: Action filter restricts results to that action code", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/audit-log?action=${ACTION_TAG}&page_size=200`,
      {
        headers: adminBypassHeaders(userIdAdmin),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const rows = body.rows as Array<{ action: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.action).toBe(ACTION_TAG);
    }
  });

  test("AC4: Date range filter restricts rows to the inclusive window", async ({
    request,
  }) => {
    // Window: from 2h ago to 30s ago — should match a-1 and b-1 (both 1h ago)
    // and exclude a-2 (7d ago) and a-3 (1m ago, which is *inside* the 30s
    // exclusion).
    const fromTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const toTs = new Date(Date.now() - 30 * 1000).toISOString();
    const res = await request.get(
      `/api/audit-log?from=${encodeURIComponent(fromTs)}&to=${encodeURIComponent(
        toTs,
      )}&page_size=200`,
      {
        headers: adminBypassHeaders(userIdAdmin),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const rows = body.rows as Array<{ id: string; timestamp: string }>;
    const idsInWindow = rows.map((r) => r.id);
    // a-1 + b-1 are inside window; a-2 (7d ago) and a-3 (1m ago) must not
    // appear among our seed rows.
    expect(idsInWindow).toContain(`${ENTITY_PREFIX}a-1`);
    expect(idsInWindow).toContain(`${ENTITY_PREFIX}b-1`);
    expect(idsInWindow).not.toContain(`${ENTITY_PREFIX}a-2`);
    expect(idsInWindow).not.toContain(`${ENTITY_PREFIX}a-3`);
    // Sanity: every returned row's timestamp must be within the window.
    for (const r of rows) {
      const ts = new Date(r.timestamp).getTime();
      expect(ts).toBeGreaterThanOrEqual(new Date(fromTs).getTime());
      expect(ts).toBeLessThanOrEqual(new Date(toTs).getTime());
    }
  });

  test("AC5: Status filter returns only matching exec_status rows", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/audit-log?status=rejected&page_size=200`,
      {
        headers: adminBypassHeaders(userIdAdmin),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const rows = body.rows as Array<{ id: string; exec_status: string }>;
    // Our seeded a-3 must appear
    expect(rows.map((r) => r.id)).toContain(`${ENTITY_PREFIX}a-3`);
    // Every returned row must have exec_status === 'rejected'
    for (const r of rows) {
      expect(r.exec_status).toBe('rejected');
    }
  });
});
