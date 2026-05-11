/**
 * E-033 — Request Immobilisation API tests (BRD §6.1.6)
 *
 * AC1: POST /request with notice_confirmed=true and a notice_text containing
 *      all five mandated components creates an action with
 *      status='pending_dual_approval'.
 * AC2: POST /request with notice_confirmed omitted/false returns 400 and does
 *      not create an action row.
 * AC3: An Ops Head calling /approve transitions the action's status to
 *      'approved'; a non-Ops user receives 403.
 * AC5: POST /remobilise on an 'approved' action with settlement_reference
 *      transitions status to 'reversed'.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import * as schema from "../../../src/lib/db/schema";

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error("DATABASE_URL must be set for E-033 API tests");
}
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? "e082-loop-bypass-secret";

function bypassHeaders(opts: { tenantId: string; userId: string; role: string }) {
  return {
    "x-nbfc-test-bypass": TEST_BYPASS_SECRET,
    "x-nbfc-test-tenant-id": opts.tenantId,
    "x-nbfc-test-user-id": opts.userId,
    "x-nbfc-test-user-role": opts.role,
  };
}

// ---------------------------------------------------------------------------
// Fixtures / cleanup
// ---------------------------------------------------------------------------
const ctx: { tenantAId: string; uploaderId: string } = {
  tenantAId: "",
  uploaderId: "",
};
const createdActionIds: string[] = [];
const createdLoanIds: string[] = [];
const createdLeadIds: string[] = [];
const createdTenantIds: string[] = [];

const NOTICE_TEXT = [
  "Lender: Acme NBFC Limited.",
  "LSP: iTarang Battery Solutions.",
  "Outstanding amount: ₹18500. Restoration: settle EMI via UPI to re-mobilise within 2-4 hours.",
  "Grievance channel: https://acme-nbfc.example.com/grievance Helpline: 1800-200-3300.",
  "This notice is in plain, non-coercive language; we will work cooperatively.",
].join("\n");

async function makeTenant(prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-033 Test NBFC ${slug}` })
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
  throw new Error("No existing leads to source uploader_id from");
}

/**
 * The endpoint zod requires `loan_sanction_id` to be a UUID. Our schema's
 * `loan_sanctions.id` is a varchar PK, so we generate a UUID-formatted id and
 * use it on both sides.
 */
async function makeLoanForTenant(tenantId: string): Promise<string> {
  const id = randomUUID();
  const lead_id = `e033-lead-${randomUUID().slice(0, 8)}`;

  await db.insert(schema.leads).values({
    id: lead_id,
    lead_source: "e033-test",
    uploader_id: ctx.uploaderId,
  });
  createdLeadIds.push(lead_id);

  await db.insert(schema.loanSanctions).values({
    id,
    lead_id,
    nbfc_id: tenantId,
    status: "sanctioned",
  });
  createdLoanIds.push(id);
  return id;
}

test.beforeAll(async () => {
  ctx.tenantAId = await makeTenant("e033a");
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
test.describe("E-033 — Request Immobilisation", () => {
  test("AC1: POST /request with confirmed full notice creates pending_dual_approval", async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const userId = randomUUID();

    const res = await request.post("/api/nbfc/actions/immobilisation/request", {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: "nbfc_risk_head",
      }),
      data: {
        loan_sanction_id: loanId,
        notice_confirmed: true,
        notice_text: NOTICE_TEXT,
        outstanding_amount: 18500,
      },
    });
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.action_id).toBeTruthy();
    expect(body.status).toBe("pending_dual_approval");
    expect(typeof body.created_at).toBe("string");
    createdActionIds.push(body.action_id);

    const rows = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, body.action_id));
    expect(rows.length).toBe(1);
    expect(rows[0].action_type).toBe("immobilisation");
    expect(rows[0].status).toBe("pending_dual_approval");
    expect(rows[0].tenant_id).toBe(ctx.tenantAId);
    expect(rows[0].loan_sanction_id).toBe(loanId);
    expect(rows[0].requested_by).toBe(userId);

    // Audit log row exists
    const audits = await db
      .select()
      .from(schema.nbfcAuditLog)
      .where(eq(schema.nbfcAuditLog.action_id, body.action_id));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  test("AC2: POST /request without notice_confirmed returns 400 and creates no row", async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const userId = randomUUID();

    // Missing notice_confirmed entirely.
    const res = await request.post("/api/nbfc/actions/immobilisation/request", {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: "nbfc_risk_head",
      }),
      data: {
        loan_sanction_id: loanId,
        notice_text: NOTICE_TEXT,
        outstanding_amount: 18500,
      },
    });
    expect(res.status()).toBe(400);

    // notice_confirmed=false also rejected.
    const res2 = await request.post("/api/nbfc/actions/immobilisation/request", {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId,
        role: "nbfc_risk_head",
      }),
      data: {
        loan_sanction_id: loanId,
        notice_confirmed: false,
        notice_text: NOTICE_TEXT,
        outstanding_amount: 18500,
      },
    });
    expect(res2.status()).toBe(400);

    // No row leaked into nbfc_borrower_actions for this loan.
    const rows = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(
        and(
          eq(schema.nbfcBorrowerActions.loan_sanction_id, loanId),
          eq(schema.nbfcBorrowerActions.tenant_id, ctx.tenantAId),
        ),
      );
    expect(rows.length).toBe(0);
  });

  test("AC3: Ops Head /approve flips to approved; non-Ops returns 403", async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const riskHeadUser = randomUUID();
    const opsHeadUser = randomUUID();
    const someoneElse = randomUUID();

    const reqRes = await request.post("/api/nbfc/actions/immobilisation/request", {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId: riskHeadUser,
        role: "nbfc_risk_head",
      }),
      data: {
        loan_sanction_id: loanId,
        notice_confirmed: true,
        notice_text: NOTICE_TEXT,
        outstanding_amount: 9000,
      },
    });
    expect(reqRes.status()).toBe(200);
    const reqBody = await reqRes.json();
    createdActionIds.push(reqBody.action_id);

    // Non-Ops user (e.g. credit manager) cannot approve.
    const forbiddenRes = await request.post(
      "/api/nbfc/actions/immobilisation/approve",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantAId,
          userId: someoneElse,
          role: "nbfc_credit_manager",
        }),
        data: { action_id: reqBody.action_id },
      },
    );
    expect(forbiddenRes.status()).toBe(403);

    // Status still pending_dual_approval — not flipped by the failed call.
    const stillPending = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, reqBody.action_id));
    expect(stillPending[0].status).toBe("pending_dual_approval");

    // Ops Head approves.
    const approveRes = await request.post(
      "/api/nbfc/actions/immobilisation/approve",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantAId,
          userId: opsHeadUser,
          role: "nbfc_ops_head",
        }),
        data: { action_id: reqBody.action_id },
      },
    );
    expect(approveRes.status()).toBe(200);
    const approveBody = await approveRes.json();
    expect(approveBody.action_id).toBe(reqBody.action_id);
    expect(approveBody.status).toBe("approved");

    const approvedRow = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, reqBody.action_id));
    expect(approvedRow[0].status).toBe("approved");
  });

  test("AC5: /remobilise on approved action flips to reversed", async ({
    request,
  }) => {
    const loanId = await makeLoanForTenant(ctx.tenantAId);
    const riskHeadUser = randomUUID();
    const opsHeadUser = randomUUID();

    // Set up: request + approve.
    const reqRes = await request.post("/api/nbfc/actions/immobilisation/request", {
      headers: bypassHeaders({
        tenantId: ctx.tenantAId,
        userId: riskHeadUser,
        role: "nbfc_risk_head",
      }),
      data: {
        loan_sanction_id: loanId,
        notice_confirmed: true,
        notice_text: NOTICE_TEXT,
        outstanding_amount: 12000,
      },
    });
    expect(reqRes.status()).toBe(200);
    const reqBody = await reqRes.json();
    createdActionIds.push(reqBody.action_id);

    const approveRes = await request.post(
      "/api/nbfc/actions/immobilisation/approve",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantAId,
          userId: opsHeadUser,
          role: "nbfc_ops_head",
        }),
        data: { action_id: reqBody.action_id },
      },
    );
    expect(approveRes.status()).toBe(200);

    // Re-mobilise.
    const remRes = await request.post(
      "/api/nbfc/actions/immobilisation/remobilise",
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantAId,
          userId: opsHeadUser,
          role: "nbfc_ops_head",
        }),
        data: {
          action_id: reqBody.action_id,
          settlement_reference: "RCPT-2026-0001",
        },
      },
    );
    expect(remRes.status(), await remRes.text().catch(() => "")).toBe(200);
    const remBody = await remRes.json();
    expect(remBody.status).toBe("reversed");

    const reversedRow = await db
      .select()
      .from(schema.nbfcBorrowerActions)
      .where(eq(schema.nbfcBorrowerActions.id, reqBody.action_id));
    expect(reversedRow[0].status).toBe("reversed");
  });
});
