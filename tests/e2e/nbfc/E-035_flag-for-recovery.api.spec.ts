/**
 * E-035 — Flag for Recovery API tests (BRD §6.1.6)
 *
 * AC1: Risk Head with reason >= 20 chars returns 200, sets
 *      loan_sanctions.recovery_flagged_at, and inserts an
 *      nbfc_recovery_pipeline row at stage='needs_inspection'.
 * AC2: Non-Risk-Head caller receives 403.
 * AC3: Calling the endpoint a second time on an already-flagged loan -> 409.
 * AC4: Audit log row exists with action='flag_for_recovery' referencing
 *      the new action_id.
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
  throw new Error('DATABASE_URL must be set for E-035 API tests');
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
const RISK_HEAD_ROLE = 'risk_head';
const NON_RISK_ROLE = 'nbfc_credit_manager';

const ctx: { tenantId: string; uploaderId: string } = { tenantId: '', uploaderId: '' };
const createdLoanIds: string[] = [];
const createdLeadIds: string[] = [];
const createdActionIds: string[] = [];

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e035-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-035 Test NBFC ${slug}` })
    .returning();
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
  const id = `e035-loan-${randomUUID().slice(0, 8)}`;
  const lead_id = `e035-lead-${randomUUID().slice(0, 8)}`;

  // FK on loan_sanctions.lead_id -> leads.id requires a lead row first.
  await db.insert(schema.leads).values({
    id: lead_id,
    lead_source: 'e035-test',
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
  ctx.tenantId = await getOrCreateTenant();
  ctx.uploaderId = await getOrCreateUploaderId();
});

test.afterAll(async () => {
  for (const aid of createdActionIds) {
    await db
      .delete(schema.auditLogs)
      .where(eq(schema.auditLogs.entity_id, aid))
      .catch(() => {});
    await db
      .delete(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, aid))
      .catch(() => {});
  }
  for (const id of createdLoanIds) {
    // Pipeline rows are keyed by battery_serial; we wrote LOAN-<id>.
    await db
      .delete(schema.nbfcRecoveryPipeline)
      .where(
        and(
          eq(schema.nbfcRecoveryPipeline.tenant_id, ctx.tenantId),
          eq(schema.nbfcRecoveryPipeline.battery_serial, `LOAN-${id}`),
        ),
      )
      .catch(() => {});
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
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe('E-035 — Flag for Recovery', () => {
  test('AC1: Risk Head flags loan, sets recovery_flagged_at and creates pipeline row', async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantId);
    const riskHeadId = randomUUID();

    const res = await request.post('/api/nbfc/actions/flag-for-recovery', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: riskHeadId,
        role: RISK_HEAD_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        reason: 'Borrower has been DPD>120 for two consecutive cycles; field visit confirmed default',
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.action_id).toBeTruthy();
    expect(body.loan_sanction_id).toBe(loanId);
    expect(body.status).toBe('approved');
    expect(typeof body.flagged_at).toBe('string');
    createdActionIds.push(body.action_id);

    // loan_sanctions.recovery_flagged_at is set
    const loanRow = await db
      .select({
        recovery_flagged_at: schema.loanSanctions.recovery_flagged_at,
        recovery_reason: schema.loanSanctions.recovery_reason,
      })
      .from(schema.loanSanctions)
      .where(eq(schema.loanSanctions.id, loanId))
      .limit(1);
    expect(loanRow[0]?.recovery_flagged_at).toBeTruthy();
    expect(loanRow[0]?.recovery_reason).toContain('DPD>120');

    // nbfc_recovery_pipeline row exists at stage='needs_inspection'
    const pipeline = await db
      .select()
      .from(schema.nbfcRecoveryPipeline)
      .where(
        and(
          eq(schema.nbfcRecoveryPipeline.tenant_id, ctx.tenantId),
          eq(schema.nbfcRecoveryPipeline.battery_serial, `LOAN-${loanId}`),
        ),
      );
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].stage).toBe('needs_inspection');
  });

  test('AC2: Non-Risk-Head caller receives 403', async ({ request }) => {
    const loanId = await makeLoanForTenant(ctx.tenantId);
    const userId = randomUUID();

    const res = await request.post('/api/nbfc/actions/flag-for-recovery', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId,
        role: NON_RISK_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        reason: 'Trying to flag from a non-risk-head role for negative test',
      },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(String(body.error)).toContain('FORBIDDEN');
  });

  test('AC3: Second call on already-flagged loan returns 409', async ({ request }) => {
    const loanId = await makeLoanForTenant(ctx.tenantId);
    const headers = bypassHeaders({
      tenantId: ctx.tenantId,
      userId: randomUUID(),
      role: RISK_HEAD_ROLE,
    });

    const first = await request.post('/api/nbfc/actions/flag-for-recovery', {
      headers,
      data: {
        loan_sanction_id: loanId,
        reason: 'First flag — borrower stopped responding to all collection calls',
      },
    });
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    createdActionIds.push(firstBody.action_id);

    const second = await request.post('/api/nbfc/actions/flag-for-recovery', {
      headers,
      data: {
        loan_sanction_id: loanId,
        reason: 'Second flag attempt should hit 409 because the first one stuck',
      },
    });
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(String(body.error)).toContain('CONFLICT');
  });

  test('AC4: Audit log row exists with action_type=flag_for_recovery referencing action_id', async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantId);

    const res = await request.post('/api/nbfc/actions/flag-for-recovery', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: RISK_HEAD_ROLE,
      }),
      data: {
        loan_sanction_id: loanId,
        reason: 'Audit-log assertion — verifying that the trail row is written',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    createdActionIds.push(body.action_id);

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.entity_id, body.action_id),
          eq(schema.auditLogs.action, 'flag_for_recovery'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].entity_type).toBe('nbfc_borrower_action');
  });
});
