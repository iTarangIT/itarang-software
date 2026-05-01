// E-009 API acceptance tests — runs the route handlers in-process against
// the sandbox Postgres so we don't have to boot the full dev server. Each
// test corresponds to one AC in
// docs/nbfc/brd_extract/E-009_nbfc-loan-product-config.yaml.
//
// Auth is bypassed by stubbing requireAdmin via a module mock. We do this
// by setting NBFC_E009_TEST_BYPASS_AUTH=1 before importing the route, and
// the route honours that bypass for tests only when NODE_ENV !== 'production'.
//
// Direct SQL fallback for migrations: we ensure tables exist and seed an
// NBFC fixture row before each suite so tests are self-contained.

import postgres from "postgres";
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { register } from "node:module";

process.env.DOTENV_CONFIG_QUIET = "true";

const ENV_FILE =
  process.env.NBFC_ENV_FILE ??
  "/Users/apoorvgupta/Desktop/Itarang Files/itarang code/test_main/keys/sandbox.env";
dotenv.config({ path: ENV_FILE, quiet: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing — set NBFC_ENV_FILE.");
  process.exit(2);
}

// Triple-guarded auth bypass — only takes effect when ALL three are true:
//   1. NODE_ENV !== 'production'
//   2. NBFC_E009_TEST_BYPASS_AUTH === '1'
//   3. The bypass token is set
process.env.NBFC_E009_TEST_BYPASS_AUTH = "1";
process.env.NBFC_E009_TEST_BYPASS_TOKEN = "e009-test-bypass-only";
process.env.NODE_ENV ??= "test";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });

// Clean fixtures from any prior run.
async function cleanup() {
  await sql`DELETE FROM nbfc_loan_products WHERE product_name LIKE 'E009-TEST-%'`;
  await sql`DELETE FROM nbfc WHERE nbfc_id LIKE 'E009-TEST-%'`;
}

async function makeNbfc(status) {
  // The sandbox `nbfc` table is the canonical one from sibling unit E-003 —
  // it has many NOT NULL columns we have to satisfy with throwaway values.
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  const ts = Date.now().toString().slice(-8);
  const tag = "E009-TEST-" + status + "-" + ts + "-" + rand;
  // RBI registration number must match  ^N-\d{2}\.\d{5}\.\d{2}\.\d{2}\.\d{4}\.\d{5}\.\d{2}$
  const rbi =
    "N-" +
    String(Math.floor(Math.random() * 100)).padStart(2, "0") +
    "." +
    String(Math.floor(Math.random() * 100000)).padStart(5, "0") +
    ".00.00.2026." +
    String(Math.floor(Math.random() * 100000)).padStart(5, "0") +
    ".01";
  const [row] = await sql`
    INSERT INTO nbfc (
      nbfc_id, legal_name, short_name, rbi_registration_no,
      cin, gst_number, pan_number, nbfc_type,
      registered_address, active_geographies,
      primary_contact_name, primary_contact_email, primary_contact_phone,
      grievance_officer_name, grievance_helpline, grievance_url,
      partnership_date, status, created_by
    ) VALUES (
      ${tag}, ${tag}, ${"E9-" + status.slice(0, 6)}, ${rbi},
      ${"L65999MH2026PTC" + rand}, ${"27ABCDE1234F1Z5"}, ${"ABCDE1234F"}, ${"nbfc_icc"},
      ${sql.json({ line1: "x", city: "y", district: "z", state: "AA", pin: "000000" })},
      ${sql.json(["AA"])},
      ${"PrimaryContact"}, ${"p@example.com"}, ${"9999999999"},
      ${"GrievanceOfficer"}, ${"1800-000-000"}, ${"https://example.com/grievance"},
      ${"2026-01-01"}, ${status}, ${1}
    )
    RETURNING id, status
  `;
  return row;
}

// We hit the endpoints over HTTP against the dev server. The lessons file
// already covers how to start the dev server alongside; here we expect a
// caller (run_tests.sh or Playwright global.setup) to have it running on
// http://localhost:3000.
const BASE = process.env.E009_BASE_URL ?? "http://localhost:3000";
const AUTH_HEADER = {
  "x-nbfc-e009-test-bypass": process.env.NBFC_E009_TEST_BYPASS_TOKEN,
};

async function api(method, p, body, qs) {
  const url = new URL(BASE + p);
  if (qs) for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...AUTH_HEADER,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json };
}

const validBody = {
  productName: "E009-TEST-Product",
  eligibleBatteryCategories: ["3W", "2W"],
  loanAmountMin: 50000,
  loanAmountMax: 500000,
  tenureMonthsMin: 6,
  tenureMonthsMax: 36,
  minRoiPct: 12.5,
  maxRoiPct: 22.0,
  downPaymentPct: 10.0,
  subventionAvailable: false,
  disbursementMethod: "direct_to_dealer",
  status: "active",
};

async function ac1(nbfcApproved) {
  // AC1: POST with valid body returns 200 and persists row.
  const body = { ...validBody, productName: "E009-TEST-AC1" };
  const r = await api(
    "POST",
    `/api/admin/nbfc/${nbfcApproved.id}/loan-products`,
    body,
  );
  assert.equal(r.status, 200, "AC1 status should be 200, got " + r.status + " " + JSON.stringify(r.json));
  assert.equal(r.json.productName, "E009-TEST-AC1");
  const [row] =
    await sql`SELECT product_name FROM nbfc_loan_products WHERE id=${r.json.id}`;
  assert.equal(row.product_name, "E009-TEST-AC1", "AC1 row not persisted");
  console.log("PASS AC1");
}

async function ac2(nbfcApproved) {
  // AC2: POST returns 422 when loanAmountMax <= loanAmountMin.
  const body = {
    ...validBody,
    productName: "E009-TEST-AC2",
    loanAmountMin: 100000,
    loanAmountMax: 100000,
  };
  const r = await api(
    "POST",
    `/api/admin/nbfc/${nbfcApproved.id}/loan-products`,
    body,
  );
  assert.equal(r.status, 422, "AC2 expected 422, got " + r.status);
  console.log("PASS AC2");
}

async function ac3(nbfcApproved) {
  // AC3: GET ?status=active returns only active rows for that NBFC.
  await api("POST", `/api/admin/nbfc/${nbfcApproved.id}/loan-products`, {
    ...validBody,
    productName: "E009-TEST-AC3-active",
    status: "active",
  });
  await api("POST", `/api/admin/nbfc/${nbfcApproved.id}/loan-products`, {
    ...validBody,
    productName: "E009-TEST-AC3-inactive",
    status: "inactive",
  });

  const r = await api(
    "GET",
    `/api/admin/nbfc/${nbfcApproved.id}/loan-products`,
    undefined,
    { status: "active" },
  );
  assert.equal(r.status, 200);
  const items = r.json.items;
  assert.ok(Array.isArray(items));
  for (const it of items)
    assert.equal(it.status, "active", "AC3 list contained non-active row");
  const names = items.map((i) => i.productName);
  assert.ok(
    names.includes("E009-TEST-AC3-active"),
    "AC3 active row missing from list",
  );
  assert.ok(
    !names.includes("E009-TEST-AC3-inactive"),
    "AC3 inactive row leaked into status=active list",
  );
  console.log("PASS AC3");
}

async function ac4(nbfcDraft) {
  // AC4: POST returns 409 when target NBFC is not approved/active.
  const body = { ...validBody, productName: "E009-TEST-AC4" };
  const r = await api(
    "POST",
    `/api/admin/nbfc/${nbfcDraft.id}/loan-products`,
    body,
  );
  assert.equal(r.status, 409, "AC4 expected 409, got " + r.status);
  console.log("PASS AC4");
}

(async () => {
  await cleanup();
  const approved = await makeNbfc("approved");
  const draft = await makeNbfc("draft");

  let failed = 0;
  for (const [name, fn] of [
    ["AC1", () => ac1(approved)],
    ["AC2", () => ac2(approved)],
    ["AC3", () => ac3(approved)],
    ["AC4", () => ac4(draft)],
  ]) {
    try {
      await fn();
    } catch (e) {
      failed++;
      console.error("FAIL " + name + ":", e.message);
    }
  }

  await cleanup();
  await sql.end();
  process.exit(failed === 0 ? 0 : 1);
})();
