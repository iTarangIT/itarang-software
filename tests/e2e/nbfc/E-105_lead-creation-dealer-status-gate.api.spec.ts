/**
 * E-105 — Lead-creation dealer-status gate (Sync Audit G-10).
 *
 * AC1: POST /api/leads/create with paymentMethod='Other finance' returns 403
 *      with body.error='DEALER_NOT_ACTIVE' and body.currentStatus equal to
 *      the dealer's onboarding_status when status != 'active'.
 * AC2: POST with paymentMethod='Other finance' returns 403 / FINANCE_NOT_ENABLED
 *      when the active dealer has finance_enabled=false.
 * AC4: POST with paymentMethod='Cash' for an active dealer succeeds even when
 *      finance_enabled=false and no NBFC assignments exist.
 * AC5: POST with paymentMethod='Other finance' succeeds for an active dealer
 *      with finance_enabled=true even when no dealer_nbfc_assignments rows
 *      exist — NBFC linkage is validated at loan-sanction time, not at
 *      lead-creation time, so the wizard's Hot+Finance → Step 2 KYC routing
 *      can proceed unblocked.
 *
 * Auth uses an x-test-dealer-code / x-test-admin-secret bypass mirroring the
 * pattern used by the admin NBFC routes.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../../../src/lib/db/schema";

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error("DATABASE_URL must be set for E-105 API tests");
}
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? "e082-loop-bypass-secret";

function dealerHeaders(dealerCode: string, userId?: string) {
  return {
    "x-test-admin-secret": TEST_BYPASS_SECRET,
    "x-test-dealer-code": dealerCode,
    "x-test-user-id": userId ?? randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const createdAssignmentIds: number[] = [];
const createdNbfcIds: number[] = [];
const createdDealerIds: number[] = [];
const createdDealerCodes: string[] = [];
const createdLeadIds: string[] = [];

function uniqTag(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  )}`;
}

async function insertTestDealer(opts: {
  onboardingStatus: string;
  financeEnabled: boolean;
}): Promise<{ id: number; dealerCode: string }> {
  const tag = uniqTag("e105d");
  const dealerCode = `DLR-${tag}`.slice(0, 50);
  const [row] = await db
    .insert(schema.dealers)
    .values({
      dealer_id: dealerCode,
      company_name: `E-105 Dealer ${tag}`,
      company_type: "individual",
      onboarding_status: opts.onboardingStatus,
      finance_enabled: opts.financeEnabled,
    })
    .returning({ id: schema.dealers.id });
  createdDealerIds.push(row.id);
  createdDealerCodes.push(dealerCode);
  return { id: row.id, dealerCode };
}

async function insertTestNbfc(): Promise<number> {
  const tag = uniqTag("e105n");
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: tag.slice(0, 50),
      legal_name: `E-105 NBFC ${tag}`,
      short_name: `E105 ${tag.slice(0, 18)}`,
      rbi_registration_no: tag.slice(0, 100),
      cin: "U65999MH2026PTC000105",
      gst_number: "27AAACT2728Q1Z7",
      pan_number: "AAACT2728Q",
      nbfc_type: "NBFC-ICC",
      registered_address: { line1: "Test Address", city: "Mumbai" },
      active_geographies: { states: ["MH"] },
      primary_contact_name: "Test Contact",
      primary_contact_email: `${tag}@example.com`,
      primary_contact_phone: "+919999999999",
      grievance_officer_name: "Test Officer",
      grievance_helpline: "1800-000-000",
      grievance_url: "https://example.com/grievance",
      partnership_date: "2026-01-01",
      status: "active",
      created_by: 1,
    })
    .returning({ id: schema.nbfc.id });
  createdNbfcIds.push(row.id);
  return row.id;
}

async function insertActiveAssignment(dealerInternalId: number, nbfcId: number) {
  const [row] = await db
    .insert(schema.dealerNbfcAssignments)
    .values({
      dealer_id: dealerInternalId,
      nbfc_id: nbfcId,
      enabled_by: 1,
      status: "active",
    })
    .returning({ id: schema.dealerNbfcAssignments.id });
  createdAssignmentIds.push(row.id);
  return row.id;
}

test.beforeAll(async () => {
  // sanity: dealers + dealer_nbfc_assignments tables present
  const cols = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('dealers','dealer_nbfc_assignments')
  `;
  if (cols.length < 2) {
    throw new Error(
      "dealers / dealer_nbfc_assignments tables missing; run schema push",
    );
  }
});

test.afterAll(async () => {
  if (createdLeadIds.length > 0) {
    await db
      .delete(schema.personalDetails)
      .where(inArray(schema.personalDetails.lead_id, createdLeadIds))
      .catch(() => {});
    await db
      .delete(schema.leads)
      .where(inArray(schema.leads.id, createdLeadIds))
      .catch(() => {});
  }
  // also clear any leads that landed against our test dealer codes
  if (createdDealerCodes.length > 0) {
    await db
      .delete(schema.leads)
      .where(inArray(schema.leads.dealer_id, createdDealerCodes))
      .catch(() => {});
    await db
      .delete(schema.accounts)
      .where(inArray(schema.accounts.id, createdDealerCodes))
      .catch(() => {});
  }
  if (createdAssignmentIds.length > 0) {
    await db
      .delete(schema.dealerNbfcAssignments)
      .where(inArray(schema.dealerNbfcAssignments.id, createdAssignmentIds))
      .catch(() => {});
  }
  if (createdDealerIds.length > 0) {
    await db
      .delete(schema.dealerNbfcAssignments)
      .where(inArray(schema.dealerNbfcAssignments.dealer_id, createdDealerIds))
      .catch(() => {});
    await db
      .delete(schema.dealers)
      .where(inArray(schema.dealers.id, createdDealerIds))
      .catch(() => {});
  }
  if (createdNbfcIds.length > 0) {
    await db
      .delete(schema.nbfc)
      .where(inArray(schema.nbfc.id, createdNbfcIds))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe("E-105 — Lead creation dealer-status gate", () => {
  test("AC1: non-active dealer blocked from creating leads", async ({
    request,
  }) => {
    const { dealerCode } = await insertTestDealer({
      onboardingStatus: "pending_admin_review",
      financeEnabled: true,
    });

    const res = await request.post("/api/leads/create", {
      headers: dealerHeaders(dealerCode),
      data: {
        initializeDraft: true,
        fresh: true,
        payment_method: "other_finance",
      },
    });

    expect(res.status(), await res.text().catch(() => "")).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("DEALER_NOT_ACTIVE");
    expect(body.currentStatus).toBe("pending_admin_review");
    expect(typeof body.message).toBe("string");

    // Sanity: no leads row inserted
    const rows = await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(eq(schema.leads.dealer_id, dealerCode));
    expect(rows.length).toBe(0);
  });

  test("AC2: finance-path lead blocked when finance_enabled is false", async ({
    request,
  }) => {
    const { dealerCode } = await insertTestDealer({
      onboardingStatus: "active",
      financeEnabled: false,
    });

    const res = await request.post("/api/leads/create", {
      headers: dealerHeaders(dealerCode),
      data: {
        initializeDraft: true,
        fresh: true,
        payment_method: "other_finance",
      },
    });

    expect(res.status(), await res.text().catch(() => "")).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("FINANCE_NOT_ENABLED");
    expect(typeof body.message).toBe("string");

    const rows = await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(eq(schema.leads.dealer_id, dealerCode));
    expect(rows.length).toBe(0);
  });

  test("AC4: cash-path lead skips finance checks", async ({
    request,
  }) => {
    const { dealerCode } = await insertTestDealer({
      onboardingStatus: "active",
      financeEnabled: false, // intentionally false — cash path must still pass
    });

    const res = await request.post("/api/leads/create", {
      headers: dealerHeaders(dealerCode),
      data: {
        initializeDraft: true,
        fresh: true,
        payment_method: "cash",
      },
    });

    expect(res.status(), await res.text().catch(() => "")).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    const leadId: string = body.data?.leadId ?? body.leadId;
    expect(typeof leadId).toBe("string");
    if (leadId) createdLeadIds.push(leadId);

    const rows = await db
      .select({ id: schema.leads.id, status: schema.leads.status })
      .from(schema.leads)
      .where(eq(schema.leads.dealer_id, dealerCode));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("INCOMPLETE");
  });

  test("AC5: finance lead created when dealer is active + finance_enabled (no NBFC assignment required at this step)", async ({ request }) => {
    const { dealerCode } = await insertTestDealer({
      onboardingStatus: "active",
      financeEnabled: true,
    });
    // Intentionally no insertTestNbfc / insertActiveAssignment — the gate
    // no longer requires an active assignment at lead-creation time. NBFC
    // selection happens at loan-sanction time (Step 5).

    const res = await request.post("/api/leads/create", {
      headers: dealerHeaders(dealerCode),
      data: {
        initializeDraft: true,
        fresh: true,
        payment_method: "other_finance",
      },
    });

    expect(res.status(), await res.text().catch(() => "")).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    const leadId: string = body.data?.leadId ?? body.leadId;
    expect(typeof leadId).toBe("string");
    if (leadId) createdLeadIds.push(leadId);

    const rows = await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(eq(schema.leads.dealer_id, dealerCode));
    expect(rows.length).toBe(1);
  });
});
