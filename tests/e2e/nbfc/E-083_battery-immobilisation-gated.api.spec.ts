/**
 * E-083 — Battery immobilisation action gated by dual approval.
 *
 * AC1: POST initiate by nbfc_risk_manager returns 200 with approval_request_id
 *      + status='pending_approval'; no row in nbfc_immobilisation_actions yet.
 * AC2: POST initiate by a non-Risk-Manager role returns 403.
 * AC3: After Risk Head approves the upstream dual-approval row, exactly one
 *      row in nbfc_immobilisation_actions exists with executed_at non-null
 *      and approval_request_id matching.
 * AC4: If the upstream approval is rejected (or expired), no row in
 *      nbfc_immobilisation_actions exists for that loan_application_id.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import * as schema from "../../../src/lib/db/schema";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error("DATABASE_URL must be set for E-083 API tests");
}
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? "e082-loop-bypass-secret";

function bypassHeaders(opts: {
  tenantId: string;
  userId: string;
  role: string;
}) {
  return {
    "x-nbfc-test-bypass": TEST_BYPASS_SECRET,
    "x-nbfc-test-tenant-id": opts.tenantId,
    "x-nbfc-test-user-id": opts.userId,
    "x-nbfc-test-user-role": opts.role,
  };
}

const ACTION_TYPE = "battery_immobilisation";
const INITIATOR_ROLE = "nbfc_risk_manager";
const APPROVER_ROLE = "nbfc_risk_head";

const ctx: { tenantId: string } = { tenantId: "" };
const createdRequestIds = new Set<string>();
const createdActionIds = new Set<string>();

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e083-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-083 Test NBFC ${slug}` })
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
  for (const id of createdActionIds) {
    await db
      .delete(schema.nbfcImmobilisationActions)
      .where(eq(schema.nbfcImmobilisationActions.id, id))
      .catch(() => {});
  }
  for (const id of createdRequestIds) {
    await db
      .delete(schema.nbfcImmobilisationActions)
      .where(eq(schema.nbfcImmobilisationActions.approval_request_id, id))
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
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe("E-083 — Battery immobilisation gated by dual approval", () => {
  test("AC1: Risk Manager initiate creates approval request without executing", async ({
    request,
  }) => {
    const initiatorId = randomUUID();
    const loanApplicationId = `LN-AC1-${randomUUID().slice(0, 8)}`;
    const imei = `IMEI-${randomUUID().slice(0, 12)}`;

    const res = await request.post(
      "/api/nbfc/actions/battery-immobilisation/initiate",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          loan_application_id: loanApplicationId,
          imei,
          reason_code: "dpd_90",
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.approval_request_id).toBeTruthy();
    expect(body.status).toBe("pending_approval");
    expect(body.action_type).toBe(ACTION_TYPE);
    createdRequestIds.add(body.approval_request_id);

    // No immobilisation row yet
    const rows = await db
      .select()
      .from(schema.nbfcImmobilisationActions)
      .where(
        eq(
          schema.nbfcImmobilisationActions.approval_request_id,
          body.approval_request_id,
        ),
      );
    expect(rows.length).toBe(0);
  });

  test("AC2: Non-Risk-Manager initiate returns 403", async ({ request }) => {
    const userId = randomUUID();
    const res = await request.post(
      "/api/nbfc/actions/battery-immobilisation/initiate",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: "nbfc_collections_agent",
        }),
        data: {
          loan_application_id: `LN-AC2-${randomUUID().slice(0, 8)}`,
          imei: `IMEI-${randomUUID().slice(0, 12)}`,
          reason_code: "manual",
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(res.status()).toBe(403);
    const err = await res.json();
    expect(String(err.error)).toContain("FORBIDDEN");
  });

  test("AC3: Risk Head approval executes the immobilisation exactly once", async ({
    request,
  }) => {
    const initiatorId = randomUUID();
    const approverId = randomUUID();
    const loanApplicationId = `LN-AC3-${randomUUID().slice(0, 8)}`;
    const imei = `IMEI-${randomUUID().slice(0, 12)}`;

    const initiate = await request.post(
      "/api/nbfc/actions/battery-immobilisation/initiate",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          loan_application_id: loanApplicationId,
          imei,
          reason_code: "dpd_60",
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(initiate.status(), await initiate.text().catch(() => "")).toBe(200);
    const initiated = await initiate.json();
    const approvalRequestId = initiated.approval_request_id as string;
    createdRequestIds.add(approvalRequestId);

    // Approver-2 = Risk Head approves the dual-approval row
    const approve = await request.post(
      `/api/nbfc/dual-approval/requests/${approvalRequestId}/approve`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: { comment: "DPD evidence reviewed; immobilisation approved." },
      },
    );
    expect(approve.status(), await approve.text().catch(() => "")).toBe(200);
    const approved = await approve.json();
    expect(approved.status).toBe("approved");

    const rows = await db
      .select()
      .from(schema.nbfcImmobilisationActions)
      .where(
        and(
          eq(
            schema.nbfcImmobilisationActions.approval_request_id,
            approvalRequestId,
          ),
          eq(
            schema.nbfcImmobilisationActions.loan_application_id,
            loanApplicationId,
          ),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0].executed_at).toBeTruthy();
    expect(rows[0].imei).toBe(imei);
    rows.forEach((r) => createdActionIds.add(r.id));
  });

  test("AC4: Rejected/expired approval prevents immobilisation execution", async ({
    request,
  }) => {
    const initiatorId = randomUUID();
    const approverId = randomUUID();
    const loanApplicationId = `LN-AC4-${randomUUID().slice(0, 8)}`;
    const imei = `IMEI-${randomUUID().slice(0, 12)}`;

    // Rejected branch
    const initiate = await request.post(
      "/api/nbfc/actions/battery-immobilisation/initiate",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          loan_application_id: loanApplicationId,
          imei,
          reason_code: "manual",
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(initiate.status()).toBe(200);
    const initiated = await initiate.json();
    const approvalRequestId = initiated.approval_request_id as string;
    createdRequestIds.add(approvalRequestId);

    const reject = await request.post(
      `/api/nbfc/dual-approval/requests/${approvalRequestId}/reject`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: approverId,
          role: APPROVER_ROLE,
        }),
        data: { rejection_reason: "Insufficient justification" },
      },
    );
    expect(reject.status(), await reject.text().catch(() => "")).toBe(200);

    const rejectedRows = await db
      .select()
      .from(schema.nbfcImmobilisationActions)
      .where(
        eq(
          schema.nbfcImmobilisationActions.loan_application_id,
          loanApplicationId,
        ),
      );
    expect(rejectedRows.length).toBe(0);

    // Expired branch
    const loanApplicationId2 = `LN-AC4b-${randomUUID().slice(0, 8)}`;
    const initiate2 = await request.post(
      "/api/nbfc/actions/battery-immobilisation/initiate",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: initiatorId,
          role: INITIATOR_ROLE,
        }),
        data: {
          loan_application_id: loanApplicationId2,
          imei: `IMEI-${randomUUID().slice(0, 12)}`,
          reason_code: "manual",
          reviewed_evidence_ack: true,
        },
      },
    );
    expect(initiate2.status()).toBe(200);
    const initiated2 = await initiate2.json();
    const approvalRequestId2 = initiated2.approval_request_id as string;
    createdRequestIds.add(approvalRequestId2);

    // Force expiry
    await db
      .update(schema.dualApprovalRequests)
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where(eq(schema.dualApprovalRequests.id, approvalRequestId2));

    const sweep = await request.post("/api/nbfc/dual-approval/cron/expire", {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: "00000000-0000-0000-0000-000000000000",
        role: "cron",
      }),
      data: {},
    });
    expect(sweep.status()).toBe(200);

    const expiredRows = await db
      .select()
      .from(schema.nbfcImmobilisationActions)
      .where(
        eq(
          schema.nbfcImmobilisationActions.loan_application_id,
          loanApplicationId2,
        ),
      );
    expect(expiredRows.length).toBe(0);
  });
});
