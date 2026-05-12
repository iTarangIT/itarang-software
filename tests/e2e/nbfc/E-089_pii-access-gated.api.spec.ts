/**
 * E-089 — PII Access Gated (BRD §6.4.3 PII Data Access row).
 *
 * AC1: POST /initiate without valid mfa_token returns 401.
 * AC2: POST /initiate with valid MFA returns 200 + status='pending_approval';
 *      no nbfc_pii_access_grants row yet.
 * AC3: After Approver-2 (itarang_compliance_officer) approves via the E-082
 *      route, the grant lands with expires_at = granted_at + 30 minutes.
 * AC4: GET /unmask with the grant's access_token returns 200 + unmasked
 *      aadhaar/pan; with an expired/unknown token returns 403.
 */
import { randomUUID, createHash } from 'node:crypto';
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
  throw new Error('DATABASE_URL must be set for E-089 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Test bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

const MFA_SECRET =
  process.env.NBFC_PII_MFA_SECRET ??
  process.env.NBFC_TEST_BYPASS_SECRET ??
  'e089-mfa-secret-fallback';

function bypassHeaders(opts: { tenantId: string; userId: string; role: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-tenant-id': opts.tenantId,
    'x-nbfc-test-user-id': opts.userId,
    'x-nbfc-test-user-role': opts.role,
  };
}

function mfaTokenFor(userId: string): string {
  return createHash('sha256')
    .update(`${userId}|${MFA_SECRET}|pii_access`)
    .digest('hex');
}

const ACTION_TYPE = 'pii_data_access';
const APPROVER_ROLE = 'itarang_compliance_officer';
const INITIATOR_ROLE = 'itarang_admin';

// Track everything created so we can clean up.
const ctx: {
  tenantId: string;
  leadId: string;
  personalDetailsId: string;
  origAadhaar: string | null;
  origPan: string | null;
} = {
  tenantId: '',
  leadId: '',
  personalDetailsId: '',
  origAadhaar: null,
  origPan: null,
};
const createdApprovalIds = new Set<string>();
const createdGrantIds = new Set<string>();

const TEST_AADHAAR = '999988887777';
const TEST_PAN = 'ABCDE1234F';

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e089-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-089 Test NBFC ${slug}` })
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

async function ensurePersonalDetails(): Promise<{
  leadId: string;
  personalDetailsId: string;
  origAadhaar: string | null;
  origPan: string | null;
}> {
  // Reuse an existing personal_details row (the leads table has many NOT NULL
  // columns we don't want to fabricate). We snapshot + restore the PII fields
  // so the test is non-destructive.
  const existing = await db
    .select({
      id: schema.personalDetails.id,
      lead_id: schema.personalDetails.lead_id,
      aadhaar_no: schema.personalDetails.aadhaar_no,
      pan_no: schema.personalDetails.pan_no,
    })
    .from(schema.personalDetails)
    .limit(1);
  if (existing.length === 0) {
    throw new Error(
      'E-089 test fixture: no personal_details rows present in DB. Seed at least one row to run.',
    );
  }
  const row = existing[0];
  await db
    .update(schema.personalDetails)
    .set({ aadhaar_no: TEST_AADHAAR, pan_no: TEST_PAN })
    .where(eq(schema.personalDetails.id, row.id));
  return {
    leadId: row.lead_id,
    personalDetailsId: row.id,
    origAadhaar: row.aadhaar_no ?? null,
    origPan: row.pan_no ?? null,
  };
}

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant();
  await ensureActionConfig();
  const fixture = await ensurePersonalDetails();
  ctx.leadId = fixture.leadId;
  ctx.personalDetailsId = fixture.personalDetailsId;
  ctx.origAadhaar = fixture.origAadhaar;
  ctx.origPan = fixture.origPan;
});

test.afterAll(async () => {
  // Delete grants first (FK on dual_approval_requests via approval_request_id is logical only).
  for (const id of createdGrantIds) {
    await db.delete(schema.nbfcPiiAccessGrants).where(eq(schema.nbfcPiiAccessGrants.id, id));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.entity_id, id));
  }
  for (const id of createdApprovalIds) {
    await db.delete(schema.dualApprovalRequests).where(eq(schema.dualApprovalRequests.id, id));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.entity_id, id));
  }
  // Restore the original PII so the fixture row is non-destructively returned
  // to its prior state.
  if (ctx.personalDetailsId) {
    await db
      .update(schema.personalDetails)
      .set({ aadhaar_no: ctx.origAadhaar, pan_no: ctx.origPan })
      .where(eq(schema.personalDetails.id, ctx.personalDetailsId));
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-089 — PII Access Gated', () => {
  test('AC1: initiate without valid mfa_token returns 401', async ({ request }) => {
    const initiatorId = randomUUID();
    const res = await request.post('/api/nbfc/actions/pii-access/initiate', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        lead_id: ctx.leadId,
        fields: ['aadhaar', 'pan'],
        mfa_token: 'this-is-not-a-real-mfa-token',
        reason_code: 'compliance_audit',
        reviewed_evidence_ack: true,
      },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(String(body.error)).toMatch(/UNAUTHORIZED|mfa|MFA/i);
  });

  test('AC2: initiate with valid MFA returns pending; no grant minted yet', async ({ request }) => {
    const initiatorId = randomUUID();
    const res = await request.post('/api/nbfc/actions/pii-access/initiate', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        lead_id: ctx.leadId,
        fields: ['aadhaar', 'pan'],
        mfa_token: mfaTokenFor(initiatorId),
        reason_code: 'compliance_audit',
        reviewed_evidence_ack: true,
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.approval_request_id).toBeTruthy();
    expect(body.status).toBe('pending_approval');
    expect(body.action_type).toBe(ACTION_TYPE);
    expect(body.required_approver_role).toBe(APPROVER_ROLE);
    createdApprovalIds.add(body.approval_request_id);

    // No grant row exists yet.
    const grants = await db
      .select()
      .from(schema.nbfcPiiAccessGrants)
      .where(eq(schema.nbfcPiiAccessGrants.approval_request_id, body.approval_request_id));
    expect(grants.length).toBe(0);
  });

  test('AC3: post-approval grant exists with 30-minute TTL', async ({ request }) => {
    const initiatorId = randomUUID();
    const approverId = randomUUID();

    // 1. initiate
    const initRes = await request.post('/api/nbfc/actions/pii-access/initiate', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        lead_id: ctx.leadId,
        fields: ['aadhaar', 'pan'],
        mfa_token: mfaTokenFor(initiatorId),
        reason_code: 'compliance_audit',
        reviewed_evidence_ack: true,
      },
    });
    expect(initRes.status()).toBe(200);
    const init = await initRes.json();
    createdApprovalIds.add(init.approval_request_id);

    // 2. Compliance Officer approves via E-082's standard route.
    const approveRes = await request.post(
      `/api/nbfc/dual-approval/requests/${init.approval_request_id}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: { comment: 'PII audit need verified' },
      },
    );
    expect(approveRes.status(), await approveRes.text().catch(() => '')).toBe(200);
    const approved = await approveRes.json();
    expect(approved.status).toBe('approved');

    // 3. Requestor polls the grants endpoint — lazy-mints the grant.
    const grantRes = await request.get(
      `/api/nbfc/actions/pii-access/grants?approval_request_id=${init.approval_request_id}`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
      },
    );
    expect(grantRes.status(), await grantRes.text().catch(() => '')).toBe(200);
    const grant = await grantRes.json();
    expect(grant.access_token).toBeTruthy();
    expect(grant.lead_id).toBe(ctx.leadId);
    createdGrantIds.add(grant.id);

    // 4. Validate TTL.
    const granted = new Date(grant.granted_at).getTime();
    const expires = new Date(grant.expires_at).getTime();
    const diffMin = (expires - granted) / (1000 * 60);
    expect(diffMin).toBeGreaterThanOrEqual(29.99);
    expect(diffMin).toBeLessThanOrEqual(30.01);
  });

  test('AC4: unmask returns full PII with valid token; expired/unknown returns 403', async ({ request }) => {
    const initiatorId = randomUUID();
    const approverId = randomUUID();

    const initRes = await request.post('/api/nbfc/actions/pii-access/initiate', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: initiatorId,
        role: INITIATOR_ROLE,
      }),
      data: {
        lead_id: ctx.leadId,
        fields: ['aadhaar', 'pan'],
        mfa_token: mfaTokenFor(initiatorId),
        reason_code: 'kyc_review',
        reviewed_evidence_ack: true,
      },
    });
    expect(initRes.status()).toBe(200);
    const init = await initRes.json();
    createdApprovalIds.add(init.approval_request_id);

    const approveRes = await request.post(
      `/api/nbfc/dual-approval/requests/${init.approval_request_id}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: {},
      },
    );
    expect(approveRes.status()).toBe(200);

    const grantRes = await request.get(
      `/api/nbfc/actions/pii-access/grants?approval_request_id=${init.approval_request_id}`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
      },
    );
    expect(grantRes.status()).toBe(200);
    const grant = await grantRes.json();
    createdGrantIds.add(grant.id);

    // 4a — valid unmask returns full PII.
    const unmaskOK = await request.get(
      `/api/nbfc/pii/unmask?lead_id=${encodeURIComponent(ctx.leadId)}&access_token=${encodeURIComponent(grant.access_token)}`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
      },
    );
    expect(unmaskOK.status(), await unmaskOK.text().catch(() => '')).toBe(200);
    const piiBody = await unmaskOK.json();
    expect(piiBody.aadhaar).toBe(TEST_AADHAAR);
    expect(piiBody.pan).toBe(TEST_PAN);
    expect(piiBody.used_count).toBe(1);

    // Verify pii_access.viewed audit log was written.
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.entity_id, grant.id),
          eq(schema.auditLogs.action, 'pii_access.viewed'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].performed_by).toBe(initiatorId);

    // 4b — unknown token returns 403.
    const unmaskBad = await request.get(
      `/api/nbfc/pii/unmask?lead_id=${encodeURIComponent(ctx.leadId)}&access_token=${'a'.repeat(64)}`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
      },
    );
    expect(unmaskBad.status()).toBe(403);

    // 4c — force expiry on the grant and re-call: 403.
    await db
      .update(schema.nbfcPiiAccessGrants)
      .set({ expires_at: new Date(Date.now() - 60 * 1000) })
      .where(eq(schema.nbfcPiiAccessGrants.id, grant.id));
    const unmaskExpired = await request.get(
      `/api/nbfc/pii/unmask?lead_id=${encodeURIComponent(ctx.leadId)}&access_token=${encodeURIComponent(grant.access_token)}`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
      },
    );
    expect(unmaskExpired.status()).toBe(403);
    const expBody = await unmaskExpired.json();
    expect(String(expBody.error)).toMatch(/EXPIRED|FORBIDDEN/i);
  });
});
