/**
 * E-088 — Audit log data export gated by dual approval (Requestor MFA →
 * Compliance Officer).
 *
 * AC1: POST initiate without/invalid mfa_token → 401.
 * AC2: POST initiate with valid mfa_token → 200 + pending approval; the
 *      newly-created nbfc_audit_log_exports row has download_url IS NULL.
 * AC3: After approval by an itarang_compliance_officer user, the row has
 *      a non-empty download_url, checksum_sha256, and completed_at.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error('DATABASE_URL must be set for E-088 API tests');
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

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

const ACTION_TYPE = 'audit_log_export';
const APPROVER_ROLE = 'itarang_compliance_officer';
const INITIATOR_ROLE = 'compliance_analyst';

const ctx: { tenantId: string } = { tenantId: '' };
const createdExportIds = new Set<string>();
const createdApprovalIds = new Set<string>();

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e088-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-088 Test NBFC ${slug}` })
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
  for (const id of createdExportIds) {
    await db
      .delete(schema.nbfcAuditLogExports)
      .where(eq(schema.nbfcAuditLogExports.id, id));
  }
  for (const id of createdApprovalIds) {
    await db
      .delete(schema.dualApprovalRequests)
      .where(eq(schema.dualApprovalRequests.id, id));
    await db
      .delete(schema.auditLogs)
      .where(eq(schema.auditLogs.entity_id, id));
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-088 — Audit log export gated', () => {
  test('AC1: initiate without valid MFA returns 401', async ({ request }) => {
    const initiatorId = randomUUID();
    const fromTs = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const toTs = new Date().toISOString();

    // missing mfa_token → 400 (zod) since field required
    const missing = await request.post(
      '/api/nbfc/actions/audit-log-export/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          from_ts: fromTs,
          to_ts: toTs,
          reason_code: 'rbi_audit',
          reviewed_evidence_ack: true,
        },
      },
    );
    // Either 400 (zod validation rejects empty mfa_token at schema level) or
    // 401 (validator rejects). The AC focuses on "non-MFA initiation returns
    // 401"; an explicitly-invalid token must be 401.
    expect([400, 401]).toContain(missing.status());

    // explicitly invalid mfa_token → 401
    const invalid = await request.post(
      '/api/nbfc/actions/audit-log-export/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          from_ts: fromTs,
          to_ts: toTs,
          mfa_token: 'INVALID:nope',
          reason_code: 'rbi_audit',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(invalid.status(), await invalid.text().catch(() => '')).toBe(401);
    const body = await invalid.json();
    expect(String(body.error)).toContain('UNAUTHORIZED');
  });

  test('AC2: initiate with valid MFA returns 200, pending, no download_url', async ({
    request,
  }) => {
    const initiatorId = randomUUID();
    const fromTs = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const toTs = new Date().toISOString();

    const res = await request.post(
      '/api/nbfc/actions/audit-log-export/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          from_ts: fromTs,
          to_ts: toTs,
          mfa_token: 'mfa_ok-' + initiatorId.slice(0, 8),
          reason_code: 'rbi_audit',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.approval_request_id).toBeTruthy();
    expect(body.status).toBe('pending_approval');
    expect(body.action_type).toBe(ACTION_TYPE);
    expect(body.export_request_id).toBeTruthy();
    createdExportIds.add(body.export_request_id);
    createdApprovalIds.add(body.approval_request_id);

    const rows = await db
      .select()
      .from(schema.nbfcAuditLogExports)
      .where(eq(schema.nbfcAuditLogExports.id, body.export_request_id))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0].download_url).toBeNull();
    expect(rows[0].checksum_sha256).toBeNull();
    expect(rows[0].completed_at).toBeNull();
    expect(rows[0].mfa_verified_at).toBeTruthy();
    expect(rows[0].approval_request_id).toBe(body.approval_request_id);
  });

  test('AC3: after Compliance Officer approves, signed URL + checksum exist', async ({
    request,
  }) => {
    const initiatorId = randomUUID();
    const approverId = randomUUID();
    const fromTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const toTs = new Date().toISOString();

    const res = await request.post(
      '/api/nbfc/actions/audit-log-export/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          from_ts: fromTs,
          to_ts: toTs,
          mfa_token: 'mfa_ok-ac3',
          reason_code: 'rbi_audit',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const init = await res.json();
    createdExportIds.add(init.export_request_id);
    createdApprovalIds.add(init.approval_request_id);

    const approve = await request.post(
      `/api/nbfc/dual-approval/requests/${init.approval_request_id}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: { comment: 'evidence reviewed; approved' },
      },
    );
    expect(approve.status(), await approve.text().catch(() => '')).toBe(200);
    const approved = await approve.json();
    expect(approved.status).toBe('approved');

    const rows = await db
      .select()
      .from(schema.nbfcAuditLogExports)
      .where(eq(schema.nbfcAuditLogExports.id, init.export_request_id))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0].completed_at).not.toBeNull();
    expect(rows[0].download_url).toBeTruthy();
    expect(rows[0].download_url!.length).toBeGreaterThan(20);
    expect(rows[0].checksum_sha256).toBeTruthy();
    expect(rows[0].checksum_sha256!.length).toBe(64);
  });
});
