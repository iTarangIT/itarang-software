/**
 * E-031 — Send Payment Reminder API tests (BRD §6.1.6)
 *
 * AC1: POST /api/nbfc/actions/payment-reminder with a valid loan_sanction_id
 *      returns 200 and persists an nbfc_borrower_actions row with
 *      action_type='payment_reminder' and status='auto_approved'.
 * AC2: Each successful invocation also inserts an nbfc_audit_log row
 *      referencing the new action_id.
 * AC3: If the loan_sanction_id belongs to a different NBFC tenant the
 *      endpoint returns 403.
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
  throw new Error('DATABASE_URL must be set for E-031 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
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
const NBFC_USER_ROLE = 'nbfc_credit_manager';

const ctx: { tenantAId: string; tenantBId: string; uploaderId: string } = {
  tenantAId: '',
  tenantBId: '',
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
    .values({ slug, display_name: `E-031 Test NBFC ${slug}` })
    .returning();
  createdTenantIds.push(row.id);
  return row.id;
}

async function getOrCreateUploaderId(): Promise<string> {
  // leads.uploader_id is NOT NULL. Reuse an existing one rather than fabricate.
  const rows = await db
    .select({ uploader_id: schema.leads.uploader_id })
    .from(schema.leads)
    .limit(1);
  if (rows.length > 0 && rows[0].uploader_id) return rows[0].uploader_id;
  throw new Error('No existing leads to source uploader_id from');
}

async function makeLoanForTenant(tenantId: string): Promise<string> {
  const id = `e031-loan-${randomUUID().slice(0, 8)}`;
  const lead_id = `e031-lead-${randomUUID().slice(0, 8)}`;

  await db.insert(schema.leads).values({
    id: lead_id,
    lead_source: 'e031-test',
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
  ctx.tenantAId = await getOrCreateTenant('e031a');
  ctx.tenantBId = await getOrCreateTenant('e031b');
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
test.describe('E-031 — Send Payment Reminder', () => {
  test('AC1: POST returns 200 and persists nbfc_borrower_actions row with auto_approved', async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const userId = randomUUID();

    const res = await request.post('/api/nbfc/actions/payment-reminder', {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: NBFC_USER_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        channel: 'sms',
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.action_id).toBeTruthy();
    expect(body.loan_sanction_id).toBe(loanId);
    expect(body.channel).toBe('sms');
    expect(body.status).toBe('auto_approved');
    expect(typeof body.created_at).toBe('string');
    createdActionIds.push(body.action_id);

    // nbfc_borrower_actions row exists with action_type='payment_reminder'
    const actionRows = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, body.action_id));
    expect(actionRows.length).toBe(1);
    expect(actionRows[0].action_type).toBe('payment_reminder');
    expect(actionRows[0].status).toBe('auto_approved');
    expect(actionRows[0].tenant_id).toBe(ctx.tenantAId);
    expect(actionRows[0].loan_sanction_id).toBe(loanId);
    expect(actionRows[0].requested_by).toBe(userId);
  });

  test('AC2: nbfc_audit_log row is inserted referencing the new action_id', async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const userId = randomUUID();

    const res = await request.post('/api/nbfc/actions/payment-reminder', {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: NBFC_USER_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        channel: 'whatsapp',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    createdActionIds.push(body.action_id);

    const audits = await db
      .select()
      .from(schema.nbfcAuditLog)
      .where(
        and(
          eq(schema.nbfcAuditLog.action_id, body.action_id),
          eq(schema.nbfcAuditLog.action_type, 'payment_reminder'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].tenant_id).toBe(ctx.tenantAId);
    expect(audits[0].user_id).toBe(userId);
    // before/after JSON state captured
    expect(audits[0].before_state).toBeTruthy();
    expect(audits[0].after_state).toBeTruthy();
    const afterState = audits[0].after_state as Record<string, unknown>;
    expect(afterState.channel).toBe('whatsapp');
    expect(afterState.action_id).toBe(body.action_id);
  });

  test('AC3: cross-tenant loan_sanction_id returns 403', async ({ request }) => {
    // Create a loan that belongs to tenant B
    const loanId = await makeLoanForTenant(ctx.tenantBId);
    const userId = randomUUID();

    // Caller asserts tenant A — should be rejected.
    const res = await request.post('/api/nbfc/actions/payment-reminder', {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: NBFC_USER_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        channel: 'email',
      },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(String(body.error)).toContain('FORBIDDEN');

    // Sanity: no action row leaked into the wrong tenant
    const leaked = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(
        and(
          eq(schema.nbfcBorrowerActions.loan_sanction_id, loanId),
          eq(schema.nbfcBorrowerActions.tenant_id, ctx.tenantAId),
        ),
      );
    expect(leaked.length).toBe(0);
  });
});
