/**
 * E-082 — Dual Approval Gate API tests.
 *
 * Each AC is one Playwright test. The route is auth-gated; we use the
 * triple-guarded test bypass (NODE_ENV != production AND NBFC_TEST_BYPASS_SECRET
 * set on server AND `x-nbfc-test-bypass` header on request) to fabricate the
 * initiator and approver actors.
 *
 * AC1: POST /requests with reviewed_evidence_ack=true returns 200,
 *      status='pending_approval', expires_at - created_at == 24h.
 * AC2: Initiator self-approve returns 403.
 * AC3: Second approver with matching role flips to 'approved' and an
 *      audit_logs row with action='dual_approval.approved' is written.
 * AC4: Reject with rejection_reason returns 200, status='rejected',
 *      audit_logs row with action='dual_approval.rejected'.
 * AC5: Cron sweep flips a stale pending_approval row to 'expired' and
 *      writes audit_logs with action='dual_approval.expired'.
 * AC6: reviewed_evidence_ack omitted/false returns 400.
 */
import { randomUUID } from 'node:crypto';
import { test, expect, request as pwRequest } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, lt } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client (separate connection from app — Drizzle)
// ---------------------------------------------------------------------------

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-082 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Test bypass plumbing
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
// Fixtures: ensure a tenant + an action_config exists for our test runs.
// ---------------------------------------------------------------------------

const ACTION_TYPE = 'battery_immobilisation';
const APPROVER_ROLE = 'nbfc_risk_head';
const INITIATOR_ROLE = 'nbfc_risk_manager';

const ctx: { tenantId: string } = { tenantId: '' };
const createdRequestIds = new Set<string>();

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e082-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-082 Test NBFC ${slug}` })
    .returning();
  return row.id;
}

async function ensureActionConfig() {
  const existing = await db
    .select()
    .from(schema.dualApprovalActionConfig)
    .where(eq(schema.dualApprovalActionConfig.action_type, ACTION_TYPE))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(schema.dualApprovalActionConfig).values({
      action_type: ACTION_TYPE,
      initiator_role: INITIATOR_ROLE,
      approver_role: APPROVER_ROLE,
    });
  }
}

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant();
  await ensureActionConfig();
});

test.afterAll(async () => {
  // Best-effort cleanup of rows we created.
  for (const id of createdRequestIds) {
    await db.delete(schema.dualApprovalRequests).where(eq(schema.dualApprovalRequests.id, id));
    await db
      .delete(schema.auditLogs)
      .where(eq(schema.auditLogs.entity_id, id));
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------

test.describe('E-082 — Dual Approval Gate', () => {
  test('AC1: Create dual approval request returns pending with 24h expiry', async ({ request }) => {
    const initiatorId = randomUUID();
    const res = await request.post('/api/nbfc/dual-approval/requests', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        action_type: ACTION_TYPE,
        entity_id: 'BAT-AC1-' + randomUUID().slice(0, 8),
        reason_code: 'dpd_overdue',
        evidence_snapshot: { dpd: 65, last_emi: '2026-04-15' },
        reviewed_evidence_ack: true,
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('pending_approval');
    expect(body.action_type).toBe(ACTION_TYPE);
    expect(body.initiator_user_id).toBe(initiatorId);
    expect(body.required_approver_role).toBe(APPROVER_ROLE);

    const created = new Date(body.created_at).getTime();
    const expires = new Date(body.expires_at).getTime();
    const diffHours = (expires - created) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(23.99);
    expect(diffHours).toBeLessThanOrEqual(24.01);

    createdRequestIds.add(body.id);
  });

  test('AC2: Initiator cannot self-approve', async ({ request }) => {
    const initiatorId = randomUUID();
    const created = await request.post('/api/nbfc/dual-approval/requests', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        action_type: ACTION_TYPE,
        entity_id: 'BAT-AC2-' + randomUUID().slice(0, 8),
        reason_code: 'dpd_overdue',
        evidence_snapshot: {},
        reviewed_evidence_ack: true,
      },
    });
    expect(created.status()).toBe(200);
    const body = await created.json();
    createdRequestIds.add(body.id);

    const approve = await request.post(
      `/api/nbfc/dual-approval/requests/${body.id}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId, // same user as initiator
          role: APPROVER_ROLE,
        }),
        data: {},
      },
    );
    expect(approve.status()).toBe(403);
    const err = await approve.json();
    expect(String(err.error)).toContain('FORBIDDEN');
  });

  test('AC3: Second approver approval updates status and writes audit log', async ({ request }) => {
    const initiatorId = randomUUID();
    const approverId = randomUUID();
    const created = await request.post('/api/nbfc/dual-approval/requests', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        action_type: ACTION_TYPE,
        entity_id: 'BAT-AC3-' + randomUUID().slice(0, 8),
        reason_code: 'dpd_overdue',
        evidence_snapshot: { dpd: 100 },
        reviewed_evidence_ack: true,
      },
    });
    expect(created.status()).toBe(200);
    const reqRow = await created.json();
    createdRequestIds.add(reqRow.id);

    const approve = await request.post(
      `/api/nbfc/dual-approval/requests/${reqRow.id}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: { comment: 'evidence reviewed' },
      },
    );
    expect(approve.status(), await approve.text().catch(() => '')).toBe(200);
    const approved = await approve.json();
    expect(approved.status).toBe('approved');
    expect(approved.approver_user_id).toBe(approverId);

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.entity_id, reqRow.id),
          eq(schema.auditLogs.action, 'dual_approval.approved'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].performed_by).toBe(approverId);
  });

  test('AC4: Rejection captures reason and writes audit log', async ({ request }) => {
    const initiatorId = randomUUID();
    const approverId = randomUUID();
    const created = await request.post('/api/nbfc/dual-approval/requests', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        action_type: ACTION_TYPE,
        entity_id: 'BAT-AC4-' + randomUUID().slice(0, 8),
        reason_code: 'dpd_overdue',
        evidence_snapshot: {},
        reviewed_evidence_ack: true,
      },
    });
    expect(created.status()).toBe(200);
    const reqRow = await created.json();
    createdRequestIds.add(reqRow.id);

    const reject = await request.post(
      `/api/nbfc/dual-approval/requests/${reqRow.id}/reject`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: { rejection_reason: 'insufficient evidence' },
      },
    );
    expect(reject.status(), await reject.text().catch(() => '')).toBe(200);
    const rejected = await reject.json();
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection_reason).toBe('insufficient evidence');

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.entity_id, reqRow.id),
          eq(schema.auditLogs.action, 'dual_approval.rejected'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  test('AC5: Expiry cron transitions stale pending rows to expired', async ({ request }) => {
    const initiatorId = randomUUID();
    const created = await request.post('/api/nbfc/dual-approval/requests', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        action_type: ACTION_TYPE,
        entity_id: 'BAT-AC5-' + randomUUID().slice(0, 8),
        reason_code: 'dpd_overdue',
        evidence_snapshot: {},
        reviewed_evidence_ack: true,
      },
    });
    expect(created.status()).toBe(200);
    const reqRow = await created.json();
    createdRequestIds.add(reqRow.id);

    // Force expires_at into the past so the cron sees it as stale.
    const inThePast = new Date(Date.now() - 60 * 1000);
    await db
      .update(schema.dualApprovalRequests)
      .set({ expires_at: inThePast })
      .where(eq(schema.dualApprovalRequests.id, reqRow.id));

    const sweep = await request.post('/api/nbfc/dual-approval/cron/expire', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: '00000000-0000-0000-0000-000000000000',
        role: 'cron',
      }),
      data: {},
    });
    expect(sweep.status(), await sweep.text().catch(() => '')).toBe(200);
    const sweepBody = await sweep.json();
    expect(sweepBody.ok).toBe(true);
    expect(sweepBody.expired_ids).toContain(reqRow.id);

    // Row is now status='expired'
    const after = await db
      .select()
      .from(schema.dualApprovalRequests)
      .where(eq(schema.dualApprovalRequests.id, reqRow.id))
      .limit(1);
    expect(after[0].status).toBe('expired');
    expect(after[0].expired_at).toBeTruthy();

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.entity_id, reqRow.id),
          eq(schema.auditLogs.action, 'dual_approval.expired'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  test('AC6: Initiator must acknowledge evidence review (false / omitted -> 400)', async ({ request }) => {
    const initiatorId = randomUUID();
    // omitted
    const omitted = await request.post('/api/nbfc/dual-approval/requests', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        action_type: ACTION_TYPE,
        entity_id: 'BAT-AC6-' + randomUUID().slice(0, 8),
        reason_code: 'dpd_overdue',
        evidence_snapshot: {},
      },
    });
    expect(omitted.status()).toBe(400);

    // false
    const falsy = await request.post('/api/nbfc/dual-approval/requests', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        action_type: ACTION_TYPE,
        entity_id: 'BAT-AC6b-' + randomUUID().slice(0, 8),
        reason_code: 'dpd_overdue',
        evidence_snapshot: {},
        reviewed_evidence_ack: false,
      },
    });
    expect(falsy.status()).toBe(400);
  });
});

// silence unused imports in some setups
void pwRequest;
void lt;
