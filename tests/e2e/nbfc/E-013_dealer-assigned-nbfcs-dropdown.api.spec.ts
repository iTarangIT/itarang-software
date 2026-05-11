/**
 * E-013 — Loan-sanction dropdown source: list active NBFCs assigned to a
 * dealer, each with their active loan products. (BRD §6.0.8 / Sync Audit G-05)
 *
 * AC1: GET /api/admin/dealers/{dealerId}/assigned-nbfcs (default status=active)
 *      returns only NBFCs whose dealer_nbfc_assignments.status='active'.
 * AC2: Each NBFC entry's `activeLoanProducts` contains only nbfc_loan_products
 *      with status='active'.
 * AC3: Returns empty `items` array when the dealer has no assignment rows.
 *
 * Auth uses the canonical NBFC test bypass (NBFC_TEST_BYPASS_SECRET).
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { inArray } from "drizzle-orm";
import * as schema from "../../../src/lib/db/schema";

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error("DATABASE_URL must be set for E-013 API tests");
}
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? "e082-loop-bypass-secret";

function bypassHeaders(opts: { userId: string; role?: string }) {
  return {
    "x-nbfc-test-bypass": TEST_BYPASS_SECRET,
    "x-nbfc-test-user-id": opts.userId,
    "x-nbfc-test-user-role": opts.role ?? "admin",
  } satisfies Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tracking + fixture helpers
// ---------------------------------------------------------------------------
const createdAssignmentIds: number[] = [];
const createdProductIds: number[] = [];
const createdNbfcIds: number[] = [];
const createdDealerIds: number[] = [];

async function insertTestNbfc(opts: { status?: string } = {}): Promise<number> {
  const tag = `e013-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  )}`;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: tag.slice(0, 50),
      legal_name: `E-013 Test NBFC ${tag}`,
      short_name: `E013 ${tag.slice(0, 18)}`,
      rbi_registration_no: tag.slice(0, 100),
      cin: "U65999MH2026PTC000013",
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
      status: opts.status ?? "approved",
      created_by: 1,
    })
    .returning({ id: schema.nbfc.id });
  createdNbfcIds.push(row.id);
  return row.id;
}

async function insertTestDealer(): Promise<number> {
  const tag = `e013d-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  )}`;
  const [row] = await db
    .insert(schema.dealers)
    .values({
      company_name: `E-013 Dealer ${tag}`,
      company_type: "individual",
      onboarding_status: "active",
      finance_enabled: true,
    })
    .returning({ id: schema.dealers.id });
  createdDealerIds.push(row.id);
  return row.id;
}

async function insertAssignment(opts: {
  dealerId: number;
  nbfcId: number;
  status: string;
}): Promise<number> {
  const [row] = await db
    .insert(schema.dealerNbfcAssignments)
    .values({
      dealer_id: opts.dealerId,
      nbfc_id: opts.nbfcId,
      enabled_by: 0,
      status: opts.status,
    })
    .returning({ id: schema.dealerNbfcAssignments.id });
  createdAssignmentIds.push(row.id);
  return row.id;
}

async function insertLoanProduct(opts: {
  nbfcId: number;
  productName: string;
  status: string;
}): Promise<number> {
  const [row] = await db
    .insert(schema.nbfcLoanProducts)
    .values({
      nbfc_id: opts.nbfcId,
      product_name: opts.productName,
      eligible_battery_categories: ["L3"],
      loan_amount_min: 10000,
      loan_amount_max: 200000,
      tenure_months_min: 6,
      tenure_months_max: 24,
      min_roi_pct: "12.00",
      max_roi_pct: "24.00",
      down_payment_pct: "10.00",
      subvention_available: false,
      file_charge_fixed: "1500.00",
      file_charge_pct: "0.00",
      disbursement_method: "bank_transfer",
      status: opts.status,
    })
    .returning({ id: schema.nbfcLoanProducts.id });
  createdProductIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
test.beforeAll(async () => {
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'dealer_nbfc_assignments'
  `;
  if (cols.length === 0) {
    throw new Error(
      "dealer_nbfc_assignments table not present in DB; run schema push",
    );
  }
});

test.afterAll(async () => {
  if (createdAssignmentIds.length > 0) {
    await db
      .delete(schema.dealerNbfcAssignments)
      .where(inArray(schema.dealerNbfcAssignments.id, createdAssignmentIds))
      .catch(() => {});
  }
  if (createdProductIds.length > 0) {
    await db
      .delete(schema.nbfcLoanProducts)
      .where(inArray(schema.nbfcLoanProducts.id, createdProductIds))
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
      .delete(schema.nbfcLoanProducts)
      .where(inArray(schema.nbfcLoanProducts.nbfc_id, createdNbfcIds))
      .catch(() => {});
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
test.describe("E-013 — Dealer assigned-NBFCs dropdown", () => {
  test("AC1: dropdown lists only active assignments", async ({ request }) => {
    const dealerId = await insertTestDealer();
    const activeNbfcId = await insertTestNbfc({ status: "approved" });
    const suspendedNbfcId = await insertTestNbfc({ status: "approved" });
    await insertAssignment({
      dealerId,
      nbfcId: activeNbfcId,
      status: "active",
    });
    await insertAssignment({
      dealerId,
      nbfcId: suspendedNbfcId,
      status: "suspended",
    });

    const userId = randomUUID();
    const res = await request.get(
      `/api/admin/dealers/${dealerId}/assigned-nbfcs`,
      { headers: bypassHeaders({ userId }) },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);

    const ids = (body.items as Array<{ nbfcId: number }>).map((i) => i.nbfcId);
    expect(ids).toContain(activeNbfcId);
    expect(ids).not.toContain(suspendedNbfcId);

    const activeEntry = body.items.find(
      (i: { nbfcId: number }) => i.nbfcId === activeNbfcId,
    );
    expect(activeEntry).toBeTruthy();
    expect(typeof activeEntry.shortName).toBe("string");
    expect(typeof activeEntry.legalName).toBe("string");
    expect(Array.isArray(activeEntry.activeLoanProducts)).toBe(true);
  });

  test("AC2: dropdown excludes inactive loan products", async ({ request }) => {
    const dealerId = await insertTestDealer();
    const nbfcId = await insertTestNbfc({ status: "approved" });
    await insertAssignment({ dealerId, nbfcId, status: "active" });

    const activeProductId = await insertLoanProduct({
      nbfcId,
      productName: "E-013 ACTIVE PRODUCT",
      status: "active",
    });
    const inactiveProductId = await insertLoanProduct({
      nbfcId,
      productName: "E-013 INACTIVE PRODUCT",
      status: "inactive",
    });

    const userId = randomUUID();
    const res = await request.get(
      `/api/admin/dealers/${dealerId}/assigned-nbfcs`,
      { headers: bypassHeaders({ userId }) },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const entry = (body.items as Array<{
      nbfcId: number;
      activeLoanProducts: Array<{ id: number }>;
    }>).find((i) => i.nbfcId === nbfcId);
    expect(entry).toBeTruthy();
    const productIds = entry!.activeLoanProducts.map((p) => p.id);
    expect(productIds).toContain(activeProductId);
    expect(productIds).not.toContain(inactiveProductId);

    // every returned product is active
    expect(
      entry!.activeLoanProducts.every((p) => productIds.includes(p.id)),
    ).toBe(true);
  });

  test("AC3: unassigned dealer yields empty dropdown", async ({ request }) => {
    const dealerId = await insertTestDealer();
    const userId = randomUUID();

    const res = await request.get(
      `/api/admin/dealers/${dealerId}/assigned-nbfcs`,
      { headers: bypassHeaders({ userId }) },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
  });
});
