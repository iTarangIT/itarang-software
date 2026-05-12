/**
 * E-032 — Request Field Visit API tests (BRD §6.1.6)
 *
 * AC1: POST /api/nbfc/actions/field-visit with reason length >= 10 returns 200
 *      and creates an nbfc_borrower_actions row with action_type='field_visit'
 *      and status='approved'.
 * AC2: POST without a reason field, or with reason shorter than 10 characters,
 *      returns 400.
 * AC3: A user without the NBFC Manager role calling the endpoint receives 403.
 * AC4: POST /api/nbfc/actions/field-visit/cancel transitions the action's
 *      status to 'reversed' and writes an audit_log row.
 *
 * Auth uses the canonical triple-guarded test bypass.
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
  throw new Error('DATABASE_URL must be set for E-032 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

const MANAGER_ROLE = 'nbfc_manager';
const NON_MANAGER_ROLE = 'viewer';

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
const ctx: { tenantAId: string; uploaderId: string } = {
  tenantAId: '',
  uploaderId: '',
};
const createdLoanIds: string[] = [];
const createdLeadIds: string[] = [];
const createdActionIds: string[] = [];
const createdTenantIds: string[] = [];

async function getOrCreateTenant(prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-032 Test NBFC ${slug}` })
    .returning();
  createdTenantIds.push(row.id);
  return row.id;
}

async function getOrCreateUploaderId(): Promise<string> {
  const rows = await db
    .select({ uploader_id: schema.leads.uploader_id })
    .from(schema.leads)
    .limit(1);
  if (rows.length > 0 && rows[0].uploader_id) return rows[0].uploader_id;
  throw new Error('No existing leads to source uploader_id from');
}

async function makeLoanForTenant(tenantId: string): Promise<string> {
  const id = `e032-loan-${randomUUID().slice(0, 8)}`;
  const lead_id = `e032-lead-${randomUUID().slice(0, 8)}`;

  await db.insert(schema.leads).values({
    id: lead_id,
    lead_source: 'e032-test',
    uploader_id: ctx.uploaderId,
  });
  createdLeadIds.push(lead_id);

  await db.insert(schema.loanSanctions).values({
    id,
    lead_id,
    nbfc_id: tenantId,
    status: 'sanctioned',
  });
  createdLoanIds.push(id);
  return id;
}

test.beforeAll(async () => {
  ctx.tenantAId = await getOrCreateTenant('e032a');
  ctx.uploaderId = await getOrCreateUploaderId();
});

test.afterAll(async () => {
  for (const aid of createdActionIds) {
    await db
      .delete(schema.nbfcAuditLog)
      .where(eq(schema.nbfcAuditLog.action_id, aid))
      .catch(() => {});
    await db
      .delete(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, aid))
      .catch(() => {});
  }
  for (const id of createdLoanIds) {
    await db
      .delete(schema.loanSanctions)
      .where(eq(schema.loanSanctions.id, id))
      .catch(() => {});
  }
  for (const lid of createdLeadIds) {
    await db
      .delete(schema.leads)
      .where(eq(schema.leads.id, lid))
      .catch(() => {});
  }
  for (const tid of createdTenantIds) {
    await db
      .delete(schema.nbfcTenants)
      .where(eq(schema.nbfcTenants.id, tid))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe('E-032 — Request Field Visit', () => {
  test('AC1: valid reason creates an approved field_visit action', async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const userId = randomUUID();

    const res = await request.post('/api/nbfc/actions/field-visit', {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: MANAGER_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        reason: 'Borrower unreachable, send field officer.',
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.action_id).toBeTruthy();
    expect(body.status).toBe('approved');
    expect(typeof body.created_at).toBe('string');
    createdActionIds.push(body.action_id);

    // Verify the row in nbfc_borrower_actions.
    const rows = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, body.action_id));
    expect(rows.length).toBe(1);
    expect(rows[0].action_type).toBe('field_visit');
    expect(rows[0].status).toBe('approved');
    expect(rows[0].tenant_id).toBe(ctx.tenantAId);
    expect(rows[0].loan_sanction_id).toBe(loanId);
    expect(rows[0].requested_by).toBe(userId);
    const payload = rows[0].payload as Record<string, unknown> | null;
    expect(payload?.reason).toBe('Borrower unreachable, send field officer.');

    // The audit log should also carry the reason.
    const audits = await db
      .select()
      .from(schema.nbfcAuditLog)
      .where(eq(schema.nbfcAuditLog.action_id, body.action_id));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const after = audits[0].after_state as Record<string, unknown>;
    expect(after.reason).toBe('Borrower unreachable, send field officer.');
  });

  test('AC2: missing reason returns 400', async ({ request }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const userId = randomUUID();

    const resMissing = await request.post('/api/nbfc/actions/field-visit', {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: MANAGER_ROLE,
      }),
      data: { loan_sanction_id: loanId },
    });
    expect(resMissing.status()).toBe(400);

    const resShort = await request.post('/api/nbfc/actions/field-visit', {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: MANAGER_ROLE,
      }),
      data: { loan_sanction_id: loanId, reason: 'too short' },
    });
    expect(resShort.status()).toBe(400);
  });

  test('AC3: non-manager role receives 403', async ({ request }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const userId = randomUUID();

    const res = await request.post('/api/nbfc/actions/field-visit', {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: NON_MANAGER_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        reason: 'Borrower unreachable, send field officer.',
      },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(String(body.error)).toContain('FORBIDDEN');

    // Sanity: no leaked action row.
    const leaked = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(
        and(
          eq(schema.nbfcBorrowerActions.loan_sanction_id, loanId),
          eq(schema.nbfcBorrowerActions.action_type, 'field_visit'),
        ),
      );
    expect(leaked.length).toBe(0);
  });

  test('AC4: cancel flips status to reversed and writes a new audit_log row', async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const userId = randomUUID();

    // 1. Create the field-visit action.
    const initRes = await request.post('/api/nbfc/actions/field-visit', {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: MANAGER_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        reason: 'Borrower unreachable, send field officer.',
      },
    });
    expect(initRes.status()).toBe(200);
    const initBody = await initRes.json();
    const actionId: string = initBody.action_id;
    createdActionIds.push(actionId);

    // 2. Cancel it.
    const cancelRes = await request.post(
      '/api/nbfc/actions/field-visit/cancel',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantAId,
          userId,
          role: MANAGER_ROLE,
        }),
        data: {
          action_id: actionId,
          reason: 'No longer needed; borrower paid.',
        },
      },
    );
    expect(cancelRes.status(), await cancelRes.text().catch(() => '')).toBe(
      200,
    );
    const cancelBody = await cancelRes.json();
    expect(cancelBody.action_id).toBe(actionId);
    expect(cancelBody.status).toBe('reversed');

    // 3. The action row's status is reversed.
    const rows = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, actionId));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('reversed');

    // 4. There are at least 2 audit_log rows tied to this action_id — the
    //    initial 'field_visit' row and the new 'field_visit_cancel' row.
    const audits = await db
      .select()
      .from(schema.nbfcAuditLog)
      .where(eq(schema.nbfcAuditLog.action_id, actionId));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const cancelAudit = audits.find(
      (r) => r.action_type === 'field_visit_cancel',
    );
    expect(cancelAudit).toBeTruthy();
    const cancelAfter = cancelAudit!.after_state as Record<string, unknown>;
    expect(cancelAfter.status).toBe('reversed');
    expect(cancelAfter.cancellation_reason).toBe(
      'No longer needed; borrower paid.',
    );
  });
});
