/**
 * E-012 — Dealer-NBFC assignment CRUD (BRD §6.0.8 / Sync Audit G-05).
 *
 * AC1: POST /api/admin/dealers/{dealerId}/nbfc-assignments with a valid
 *      approved nbfcId returns 200 and inserts a row with status='active'.
 * AC2: POST referencing the same dealer-nbfc pair twice returns 409 on the
 *      second call.
 * AC3: POST returns 422 when target nbfc.status not in {'approved','active'}.
 * AC4: PATCH /api/admin/nbfc-assignments/{assignmentId} with status='suspended'
 *      updates the row's status to 'suspended'.
 *
 * Auth uses the canonical NBFC test bypass (NBFC_TEST_BYPASS_SECRET).
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
  throw new Error("DATABASE_URL must be set for E-012 API tests");
}
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? "e082-loop-bypass-secret";

function bypassHeaders(opts: { userId: string; role?: string; enabledBy?: number }) {
  const headers: Record<string, string> = {
    "x-nbfc-test-bypass": TEST_BYPASS_SECRET,
    "x-nbfc-test-user-id": opts.userId,
    "x-nbfc-test-user-role": opts.role ?? "admin",
  };
  if (opts.enabledBy !== undefined) {
    headers["x-nbfc-test-enabled-by"] = String(opts.enabledBy);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const createdAssignmentIds: number[] = [];
const createdNbfcIds: number[] = [];
const createdDealerIds: number[] = [];

async function insertTestNbfc(opts: { status: string }): Promise<number> {
  const tag = `e012-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  )}`;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: tag.slice(0, 50),
      legal_name: `E-012 Test NBFC ${tag}`,
      short_name: `E012 ${tag.slice(0, 18)}`,
      rbi_registration_no: tag.slice(0, 100),
      cin: "U65999MH2026PTC000012",
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
      status: opts.status,
      created_by: 1,
    })
    .returning({ id: schema.nbfc.id });
  createdNbfcIds.push(row.id);
  return row.id;
}

async function insertTestDealer(): Promise<number> {
  const tag = `e012d-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  )}`;
  const [row] = await db
    .insert(schema.dealers)
    .values({
      company_name: `E-012 Dealer ${tag}`,
      company_type: "individual",
      onboarding_status: "active",
      finance_enabled: true,
    })
    .returning({ id: schema.dealers.id });
  createdDealerIds.push(row.id);
  return row.id;
}

test.beforeAll(async () => {
  // sanity check: verify the new table exists
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
  // also clear by dealer in case we missed any (e.g. POST that didn't push id)
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
test.describe("E-012 — Dealer-NBFC assignment CRUD", () => {
  test("AC1: POST with valid approved nbfcId returns 200 and inserts active row", async ({
    request,
  }) => {
    const dealerId = await insertTestDealer();
    const nbfcId = await insertTestNbfc({ status: "approved" });
    const userId = randomUUID();

    const res = await request.post(
      `/api/admin/dealers/${dealerId}/nbfc-assignments`,
      {
        headers: bypassHeaders({ userId, enabledBy: 42 }),
        data: { nbfcId, notes: "AC1 happy path" },
      },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.id).toBeGreaterThan(0);
    expect(body.dealerId).toBe(dealerId);
    expect(body.nbfcId).toBe(nbfcId);
    expect(body.status).toBe("active");
    expect(typeof body.enabledAt).toBe("string");
    createdAssignmentIds.push(body.id);

    // DB row matches the response
    const [persisted] = await db
      .select()
      .from(schema.dealerNbfcAssignments)
      .where(eq(schema.dealerNbfcAssignments.id, body.id));
    expect(persisted).toBeTruthy();
    expect(persisted.status).toBe("active");
    expect(persisted.dealer_id).toBe(dealerId);
    expect(persisted.nbfc_id).toBe(nbfcId);
    expect(persisted.enabled_by).toBe(42);
    expect(persisted.notes).toBe("AC1 happy path");
  });

  test("AC2: duplicate dealer-nbfc pair returns 409 on second call", async ({
    request,
  }) => {
    const dealerId = await insertTestDealer();
    const nbfcId = await insertTestNbfc({ status: "active" });
    const userId = randomUUID();
    const headers = bypassHeaders({ userId });

    const first = await request.post(
      `/api/admin/dealers/${dealerId}/nbfc-assignments`,
      { headers, data: { nbfcId } },
    );
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    createdAssignmentIds.push(firstBody.id);

    const second = await request.post(
      `/api/admin/dealers/${dealerId}/nbfc-assignments`,
      { headers, data: { nbfcId } },
    );
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(String(body.error)).toBe("already_assigned");

    // Sanity: only one row exists for this pair
    const rows = await db
      .select()
      .from(schema.dealerNbfcAssignments)
      .where(eq(schema.dealerNbfcAssignments.dealer_id, dealerId));
    expect(rows.length).toBe(1);
  });

  test("AC3: POST returns 422 when nbfc.status not in {approved,active}", async ({
    request,
  }) => {
    const dealerId = await insertTestDealer();
    const draftNbfcId = await insertTestNbfc({ status: "draft" });
    const userId = randomUUID();

    const res = await request.post(
      `/api/admin/dealers/${dealerId}/nbfc-assignments`,
      {
        headers: bypassHeaders({ userId }),
        data: { nbfcId: draftNbfcId },
      },
    );
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(String(body.error)).toBe("nbfc_not_approved");
    expect(body.nbfcStatus).toBe("draft");

    // Sanity: no row was inserted
    const rows = await db
      .select()
      .from(schema.dealerNbfcAssignments)
      .where(eq(schema.dealerNbfcAssignments.dealer_id, dealerId));
    expect(rows.length).toBe(0);
  });

  test("AC4: PATCH status='suspended' transitions an active row to suspended", async ({
    request,
  }) => {
    const dealerId = await insertTestDealer();
    const nbfcId = await insertTestNbfc({ status: "approved" });
    const userId = randomUUID();
    const headers = bypassHeaders({ userId });

    // Seed: create active assignment
    const create = await request.post(
      `/api/admin/dealers/${dealerId}/nbfc-assignments`,
      { headers, data: { nbfcId } },
    );
    expect(create.status()).toBe(200);
    const created = await create.json();
    const assignmentId = created.id as number;
    createdAssignmentIds.push(assignmentId);

    // PATCH -> suspended
    const patch = await request.patch(
      `/api/admin/nbfc-assignments/${assignmentId}`,
      {
        headers,
        data: { status: "suspended", notes: "AC4 suspend" },
      },
    );
    expect(patch.status(), await patch.text().catch(() => "")).toBe(200);
    const patchBody = await patch.json();
    expect(patchBody.success).toBe(true);
    expect(patchBody.id).toBe(assignmentId);
    expect(patchBody.status).toBe("suspended");
    expect(patchBody.notes).toBe("AC4 suspend");

    const [persisted] = await db
      .select()
      .from(schema.dealerNbfcAssignments)
      .where(eq(schema.dealerNbfcAssignments.id, assignmentId));
    expect(persisted.status).toBe("suspended");
    expect(persisted.notes).toBe("AC4 suspend");
  });
});
