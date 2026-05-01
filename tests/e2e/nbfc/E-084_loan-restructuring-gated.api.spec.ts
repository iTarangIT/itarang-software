/**
 * E-084 — Loan Restructuring (gated by E-082 dual approval) API tests.
 *
 * AC1: POST /initiate by 'nbfc_risk_manager' returns 200 with
 *      approval_request_id and status='pending_approval'; nbfc_loans is unchanged.
 * AC2: POST /initiate by a non-Risk-Manager role returns 403.
 * AC3: After Credit-Manager approval, exactly one nbfc_loan_restructures row
 *      exists and nbfc_loans.emi_amount equals new_emi_amount.
 * AC4: If the approval is rejected, nbfc_loans EMI fields remain unchanged
 *      and no nbfc_loan_restructures row is created.
 *
 * Auth: triple-guarded test bypass — NODE_ENV != production AND server
 * NBFC_TEST_BYPASS_SECRET AND request x-nbfc-test-bypass header.
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
  throw new Error('DATABASE_URL must be set for E-084 API tests');
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
// Fixtures
// ---------------------------------------------------------------------------

const ACTION_TYPE = 'loan_restructuring';
const INITIATOR_ROLE = 'nbfc_risk_manager';
const APPROVER_ROLE = 'nbfc_credit_manager';

const ctx: { tenantId: string } = { tenantId: '' };
const createdRequestIds = new Set<string>();
const createdLoanIds = new Set<string>();
const createdLoanApplicationIds = new Set<string>();
const createdLeadIds = new Set<string>();
const createdRestructureIds = new Set<string>();

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e084-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-084 Test NBFC ${slug}` })
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

async function makeLoan(tenantId: string, emi = 5000, dom = 5): Promise<string> {
  // nbfc_loans.loan_application_id has an FK to loan_applications(id), which
  // in turn has lead_id NOT NULL FK -> leads(id). So seed parents first.
  const leadId = `E084-LEAD-${randomUUID().slice(0, 8)}`;
  await db.insert(schema.leads).values({
    id: leadId,
    lead_source: 'manual',
    uploader_id: randomUUID(),
  } as never);
  createdLeadIds.add(leadId);

  const loanId = `E-084-LOAN-${randomUUID().slice(0, 8)}`;
  await db.insert(schema.loanApplications).values({
    id: loanId,
    lead_id: leadId,
  } as never);
  createdLoanApplicationIds.add(loanId);

  await db.insert(schema.nbfcLoans).values({
    loan_application_id: loanId,
    tenant_id: tenantId,
    emi_amount: String(emi),
    emi_due_date_dom: dom,
    outstanding_amount: '120000.00',
  });
  createdLoanIds.add(loanId);
  return loanId;
}

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant();
  await ensureActionConfig();
});

test.afterAll(async () => {
  for (const id of createdRestructureIds) {
    await db
      .delete(schema.nbfcLoanRestructures)
      .where(eq(schema.nbfcLoanRestructures.id, id))
      .catch(() => {});
  }
  for (const id of createdRequestIds) {
    await db
      .delete(schema.nbfcLoanRestructures)
      .where(eq(schema.nbfcLoanRestructures.approval_request_id, id))
      .catch(() => {});
    await db
      .delete(schema.dualApprovalRequests)
      .where(eq(schema.dualApprovalRequests.id, id))
      .catch(() => {});
    await db
      .delete(schema.auditLogs)
      .where(eq(schema.auditLogs.entity_id, id))
      .catch(() => {});
  }
  for (const loanId of createdLoanIds) {
    await db
      .delete(schema.nbfcLoans)
      .where(eq(schema.nbfcLoans.loan_application_id, loanId))
      .catch(() => {});
  }
  for (const loanAppId of createdLoanApplicationIds) {
    await db
      .delete(schema.loanApplications)
      .where(eq(schema.loanApplications.id, loanAppId))
      .catch(() => {});
  }
  for (const leadId of createdLeadIds) {
    await db
      .delete(schema.leads)
      .where(eq(schema.leads.id, leadId))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------

test.describe('E-084 — Loan Restructuring (gated)', () => {
  test('AC1: Restructure initiate creates approval without applying', async ({
    request,
  }) => {
    const loanId = await makeLoan(ctx.tenantId, 5000, 5);
    const initiatorId = randomUUID();

    const res = await request.post(
      '/api/nbfc/actions/loan-restructuring/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          loan_application_id: loanId,
          new_emi_amount: 4000,
          new_tenure_months: 36,
          new_emi_due_dom: 10,
          reason_code: 'borrower_distress',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.approval_request_id).toBeTruthy();
    expect(body.status).toBe('pending_approval');
    expect(body.action_type).toBe('loan_restructuring');
    createdRequestIds.add(body.approval_request_id);

    // nbfc_loans is unchanged.
    const loanAfter = await db
      .select()
      .from(schema.nbfcLoans)
      .where(eq(schema.nbfcLoans.loan_application_id, loanId))
      .limit(1);
    expect(Number(loanAfter[0].emi_amount)).toBe(5000);
    expect(loanAfter[0].emi_due_date_dom).toBe(5);

    // No restructure row written yet.
    const restructures = await db
      .select()
      .from(schema.nbfcLoanRestructures)
      .where(
        eq(schema.nbfcLoanRestructures.approval_request_id, body.approval_request_id),
      );
    expect(restructures.length).toBe(0);
  });

  test('AC2: Only Risk Manager can initiate restructure', async ({ request }) => {
    const loanId = await makeLoan(ctx.tenantId, 5000, 5);
    const userId = randomUUID();

    const res = await request.post(
      '/api/nbfc/actions/loan-restructuring/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: 'nbfc_collections_agent',
        }),
        data: {
          loan_application_id: loanId,
          new_emi_amount: 4000,
          new_tenure_months: 36,
          new_emi_due_dom: 10,
          reason_code: 'borrower_distress',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(res.status()).toBe(403);
    const err = await res.json();
    expect(String(err.error)).toContain('FORBIDDEN');
  });

  test('AC3: Restructure applies only after Credit Manager approves', async ({
    request,
  }) => {
    const loanId = await makeLoan(ctx.tenantId, 6000, 7);
    const initiatorId = randomUUID();
    const approverId = randomUUID();

    const initRes = await request.post(
      '/api/nbfc/actions/loan-restructuring/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          loan_application_id: loanId,
          new_emi_amount: 4500,
          new_tenure_months: 48,
          new_emi_due_dom: 15,
          reason_code: 'borrower_distress',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(initRes.status()).toBe(200);
    const initBody = await initRes.json();
    createdRequestIds.add(initBody.approval_request_id);

    const approveRes = await request.post(
      `/api/nbfc/dual-approval/requests/${initBody.approval_request_id}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: { comment: 'borrower hardship verified' },
      },
    );
    expect(approveRes.status(), await approveRes.text().catch(() => '')).toBe(200);
    const approved = await approveRes.json();
    expect(approved.status).toBe('approved');

    // Exactly one restructure row exists for this approval.
    const restructures = await db
      .select()
      .from(schema.nbfcLoanRestructures)
      .where(
        eq(schema.nbfcLoanRestructures.approval_request_id, initBody.approval_request_id),
      );
    expect(restructures.length).toBe(1);
    expect(restructures[0].loan_application_id).toBe(loanId);
    expect(Number(restructures[0].new_emi_amount)).toBe(4500);
    expect(restructures[0].new_tenure_months).toBe(48);
    expect(restructures[0].new_emi_due_dom).toBe(15);
    expect(Number(restructures[0].prior_emi_amount)).toBe(6000);
    createdRestructureIds.add(restructures[0].id);

    // nbfc_loans EMI fields are updated.
    const loanAfter = await db
      .select()
      .from(schema.nbfcLoans)
      .where(eq(schema.nbfcLoans.loan_application_id, loanId))
      .limit(1);
    expect(Number(loanAfter[0].emi_amount)).toBe(4500);
    expect(loanAfter[0].emi_due_date_dom).toBe(15);
  });

  test('AC4: Rejected restructure does not mutate loan', async ({ request }) => {
    const loanId = await makeLoan(ctx.tenantId, 7000, 12);
    const initiatorId = randomUUID();
    const approverId = randomUUID();

    const initRes = await request.post(
      '/api/nbfc/actions/loan-restructuring/initiate',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          loan_application_id: loanId,
          new_emi_amount: 5500,
          new_tenure_months: 60,
          new_emi_due_dom: 20,
          reason_code: 'borrower_distress',
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(initRes.status()).toBe(200);
    const initBody = await initRes.json();
    createdRequestIds.add(initBody.approval_request_id);

    const rejectRes = await request.post(
      `/api/nbfc/dual-approval/requests/${initBody.approval_request_id}/reject`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: { rejection_reason: 'restructure terms not justified' },
      },
    );
    expect(rejectRes.status(), await rejectRes.text().catch(() => '')).toBe(200);

    // No restructure row created.
    const restructures = await db
      .select()
      .from(schema.nbfcLoanRestructures)
      .where(
        and(
          eq(schema.nbfcLoanRestructures.approval_request_id, initBody.approval_request_id),
          eq(schema.nbfcLoanRestructures.loan_application_id, loanId),
        ),
      );
    expect(restructures.length).toBe(0);

    // nbfc_loans EMI fields unchanged.
    const loanAfter = await db
      .select()
      .from(schema.nbfcLoans)
      .where(eq(schema.nbfcLoans.loan_application_id, loanId))
      .limit(1);
    expect(Number(loanAfter[0].emi_amount)).toBe(7000);
    expect(loanAfter[0].emi_due_date_dom).toBe(12);
  });
});
