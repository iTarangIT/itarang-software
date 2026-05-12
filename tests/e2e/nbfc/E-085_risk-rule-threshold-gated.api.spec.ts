/**
 * E-085 — Risk rule threshold change gated by dual approval
 * (BRD §6.4.3: iTarang Admin → iTarang Risk Head / Super Admin).
 *
 * AC1: POST /api/nbfc/actions/risk-rule-threshold/initiate by an iTarang Admin
 *      returns 200 with approval_request_id and status='pending_approval';
 *      no row in nbfc_risk_rule_thresholds yet.
 * AC2: Same POST by a non-admin returns 403.
 * AC3: After approval by an iTarang Risk Head / Super Admin user, exactly one
 *      new row in nbfc_risk_rule_thresholds exists with is_active=true; the
 *      previously active row for rule_key has is_active=false.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client (separate connection from the Next.js app)
// ---------------------------------------------------------------------------

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-085 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Test bypass headers (triple-guarded; matches E-082 plumbing)
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
// Action-config fixture: ensure 'risk_rule_threshold_change' resolves to
// itarang_risk_head as Approver-2 for the test tenant.
// ---------------------------------------------------------------------------

const ACTION_TYPE = 'risk_rule_threshold_change';
const INITIATOR_ROLE = 'itarang_admin';
const APPROVER_ROLE = 'itarang_risk_head';

const ctx: { tenantId: string } = { tenantId: '' };
const createdApprovalIds = new Set<string>();
const createdThresholdIds = new Set<string>();

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e085-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-085 Test NBFC ${slug}` })
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
  for (const id of createdThresholdIds) {
    await db
      .delete(schema.nbfcRiskRuleThresholds)
      .where(eq(schema.nbfcRiskRuleThresholds.id, id));
  }
  for (const id of createdApprovalIds) {
    await db
      .delete(schema.dualApprovalRequests)
      .where(eq(schema.dualApprovalRequests.id, id));
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.entity_id, id));
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-085 — Risk rule threshold change (dual-approval gated)', () => {
  test('AC1: iTarang Admin initiate returns pending_approval; no threshold row yet', async ({
    request,
  }) => {
    const initiatorId = randomUUID();
    const ruleKey = `e085-rule-ac1-${randomUUID().slice(0, 8)}`;

    const res = await request.post(
      '/api/nbfc/actions/risk-rule-threshold/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          rule_key: ruleKey,
          current_threshold_json: { dpd_days: 60 },
          proposed_threshold_json: { dpd_days: 45 },
          reason_code: 'rbi_advisory_2026',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.approval_request_id).toBeTruthy();
    expect(body.status).toBe('pending_approval');
    expect(body.action_type).toBe(ACTION_TYPE);
    expect(body.entity_id).toBe(ruleKey);
    expect(body.required_approver_role).toBe(APPROVER_ROLE);

    createdApprovalIds.add(body.approval_request_id);

    // No threshold row yet — apply only happens on approve.
    const rows = await db
      .select()
      .from(schema.nbfcRiskRuleThresholds)
      .where(
        eq(
          schema.nbfcRiskRuleThresholds.approval_request_id,
          body.approval_request_id,
        ),
      );
    expect(rows.length).toBe(0);
  });

  test('AC2: non-admin initiate returns 403', async ({ request }) => {
    const initiatorId = randomUUID();
    const ruleKey = `e085-rule-ac2-${randomUUID().slice(0, 8)}`;

    const res = await request.post(
      '/api/nbfc/actions/risk-rule-threshold/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: 'viewer', // not an iTarang Admin role
        }),
        data: {
          rule_key: ruleKey,
          current_threshold_json: { dpd_days: 60 },
          proposed_threshold_json: { dpd_days: 45 },
          reason_code: 'rbi_advisory_2026',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(String(body.error)).toContain('FORBIDDEN');
  });

  test('AC3: approval by itarang_risk_head appends active row and supersedes prior', async ({
    request,
  }) => {
    // Use a unique rule_key per run so the "previously active row" assertion
    // is deterministic across re-runs.
    const ruleKey = `e085-rule-ac3-${randomUUID().slice(0, 8)}`;
    const initiator1 = randomUUID();
    const approver1 = randomUUID();

    // ---- First approved threshold (becomes the "previously active" row) ----
    const init1 = await request.post(
      '/api/nbfc/actions/risk-rule-threshold/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiator1,
          role: INITIATOR_ROLE,
        }),
        data: {
          rule_key: ruleKey,
          current_threshold_json: { dpd_days: 90 },
          proposed_threshold_json: { dpd_days: 60 },
          reason_code: 'baseline_threshold',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(init1.status(), await init1.text().catch(() => '')).toBe(200);
    const init1Body = await init1.json();
    createdApprovalIds.add(init1Body.approval_request_id);

    const approve1 = await request.post(
      `/api/nbfc/dual-approval/requests/${init1Body.approval_request_id}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approver1,
          role: APPROVER_ROLE,
        }),
        data: { comment: 'baseline ok' },
      },
    );
    expect(approve1.status(), await approve1.text().catch(() => '')).toBe(200);

    // After first approval: exactly one active row for this rule_key.
    let activeRows = await db
      .select()
      .from(schema.nbfcRiskRuleThresholds)
      .where(
        and(
          eq(schema.nbfcRiskRuleThresholds.rule_key, ruleKey),
          eq(schema.nbfcRiskRuleThresholds.is_active, true),
        ),
      );
    expect(activeRows.length).toBe(1);
    activeRows.forEach((r) => createdThresholdIds.add(r.id));
    const firstActiveId = activeRows[0].id;

    // ---- Second approved threshold (must supersede the first) ----
    const initiator2 = randomUUID();
    const approver2 = randomUUID();
    const init2 = await request.post(
      '/api/nbfc/actions/risk-rule-threshold/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiator2,
          role: INITIATOR_ROLE,
        }),
        data: {
          rule_key: ruleKey,
          current_threshold_json: { dpd_days: 60 },
          proposed_threshold_json: { dpd_days: 45 },
          reason_code: 'rbi_q2_tightening',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(init2.status()).toBe(200);
    const init2Body = await init2.json();
    createdApprovalIds.add(init2Body.approval_request_id);

    const approve2 = await request.post(
      `/api/nbfc/dual-approval/requests/${init2Body.approval_request_id}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approver2,
          role: APPROVER_ROLE,
        }),
        data: { comment: 'tighten' },
      },
    );
    expect(approve2.status(), await approve2.text().catch(() => '')).toBe(200);
    const approve2Body = await approve2.json();
    expect(approve2Body.status).toBe('approved');
    expect(approve2Body.applied?.rule_key).toBe(ruleKey);
    expect(approve2Body.applied?.is_active).toBe(true);

    // Exactly one active row, and it's the new one.
    activeRows = await db
      .select()
      .from(schema.nbfcRiskRuleThresholds)
      .where(
        and(
          eq(schema.nbfcRiskRuleThresholds.rule_key, ruleKey),
          eq(schema.nbfcRiskRuleThresholds.is_active, true),
        ),
      );
    expect(activeRows.length).toBe(1);
    expect(activeRows[0].id).not.toBe(firstActiveId);
    expect(activeRows[0].approval_request_id).toBe(
      init2Body.approval_request_id,
    );
    activeRows.forEach((r) => createdThresholdIds.add(r.id));

    // The previously-active row is now is_active=false.
    const previouslyActive = await db
      .select()
      .from(schema.nbfcRiskRuleThresholds)
      .where(eq(schema.nbfcRiskRuleThresholds.id, firstActiveId))
      .limit(1);
    expect(previouslyActive[0].is_active).toBe(false);
  });
});
