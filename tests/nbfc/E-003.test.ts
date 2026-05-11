/**
 * E-003 — NBFC master details CRUD.
 * Standalone runner: tsx tests/nbfc/E-003.test.ts
 *
 * Loads DATABASE_URL from keys/sandbox.env (NBFC_ENV_FILE override),
 * triple-guards the test bypass, and invokes the App Router handlers
 * directly with crafted NextRequest objects. No Next dev server needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ----- env bootstrap -----
const ENV_FILE =
  process.env.NBFC_ENV_FILE ||
  path.resolve(__dirname, "../../../../../keys/sandbox.env");
if (fs.existsSync(ENV_FILE)) {
  const raw = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] == null) {
      process.env[m[1]] = m[2];
    }
  }
}
// NODE_ENV is readonly in @types/node typings; use index access at runtime.
(process.env as Record<string, string | undefined>)["NODE_ENV"] =
  process.env.NODE_ENV || "test";
process.env.NBFC_TEST_BYPASS = "1";
process.env.NBFC_TEST_BYPASS_SECRET = "test-bypass";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing — env file not loaded:", ENV_FILE);
  process.exit(2);
}

const RESULTS: { id: string; name: string; ok: boolean; detail?: string }[] = [];

function pass(id: string, name: string) {
  RESULTS.push({ id, name, ok: true });
  console.log(`  PASS  ${id}  ${name}`);
}
function fail(id: string, name: string, detail: string) {
  RESULTS.push({ id, name, ok: false, detail });
  console.log(`  FAIL  ${id}  ${name}\n        ${detail}`);
}

async function importHandlers() {
  // Imported lazily so env is set first.
  // path resolution is from this file's dir.
  const collection = await import(
    path.resolve(__dirname, "../../src/app/api/admin/nbfc/route.ts")
  );
  const item = await import(
    path.resolve(__dirname, "../../src/app/api/admin/nbfc/[id]/route.ts")
  );
  return { POST: collection.POST, GET: item.GET, PATCH: item.PATCH };
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-test-admin-id": "1",
    "x-test-admin-secret": "test-bypass",
  };
}

function makeReq(url: string, method: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: authHeaders(),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

function uniqueRbiNo() {
  // RBI format: N-XX.XXXXX.XX.XX.XXXX.XXXXX.XX
  const r = (n: number) =>
    Math.floor(Math.random() * 10 ** n)
      .toString()
      .padStart(n, "0");
  return `N-${r(2)}.${r(5)}.${r(2)}.${r(2)}.${r(4)}.${r(5)}.${r(2)}`;
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    legalName: "Acme Capital NBFC Ltd",
    shortName: "AcmeCap",
    rbiRegistrationNo: uniqueRbiNo(),
    cin: "U65999MH2020PLC123456",
    gstNumber: "27AABCU9603R1ZX",
    panNumber: "AABCU9603R",
    nbfcType: "nbfc_icc" as const,
    registeredAddress: {
      line1: "Tower A",
      line2: "BKC",
      city: "Mumbai",
      district: "Mumbai",
      state: "Maharashtra",
      pin: "400051",
    },
    primaryContactName: "Asha Iyer",
    primaryContactEmail: "asha@acmecap.example.com",
    primaryContactPhone: "9876543210",
    grievanceOfficerName: "Ravi Patil",
    grievanceHelpline: "1800-200-3300",
    grievanceUrl: "https://acmecap.example.com/grievance",
    nodalOfficer: "Mr Nodal",
    partnershipDate: "2025-01-15",
    fldgTerms: "5% FLDG cap, 12-month tenor",
    activeGeographies: ["Maharashtra", "Karnataka", "Tamil Nadu"],
    ...overrides,
  };
}

async function run() {
  const { POST, GET, PATCH } = await importHandlers();

  // ===== AC1: create persists row with system-generated nbfc_id =====
  let createdId: number | null = null;
  let createdNbfcId: string | null = null;
  let createdLegalName: string | null = null;
  {
    const payload = basePayload();
    createdLegalName = payload.legalName;
    const req = makeReq(
      "http://localhost/api/admin/nbfc",
      "POST",
      payload,
    );
    const res: Response = await POST(req);
    const j = await res.json();
    if (res.status !== 200) {
      fail("AC1", "create persists row with system-generated nbfc_id",
        `status=${res.status} body=${JSON.stringify(j)}`);
    } else if (
      !j.success ||
      typeof j.id !== "number" ||
      typeof j.nbfcId !== "string" ||
      !/^NBFC-[A-Z0-9]{8}$/.test(j.nbfcId) ||
      j.status !== "draft"
    ) {
      fail("AC1", "create persists row with system-generated nbfc_id",
        `unexpected body=${JSON.stringify(j)}`);
    } else {
      createdId = j.id;
      createdNbfcId = j.nbfcId;
      pass("AC1", "create persists row with system-generated nbfc_id");
    }
  }

  // ===== AC2: 422 when grievance_* missing =====
  {
    const payload: Record<string, unknown> = basePayload({
      rbiRegistrationNo: uniqueRbiNo(),
    });
    delete payload.grievanceOfficerName;
    delete payload.grievanceHelpline;
    delete payload.grievanceUrl;
    const req = makeReq("http://localhost/api/admin/nbfc", "POST", payload);
    const res: Response = await POST(req);
    if (res.status !== 422) {
      const j = await res.json().catch(() => ({}));
      fail("AC2", "create rejects missing RBI-mandatory grievance fields",
        `expected 422 got ${res.status} body=${JSON.stringify(j)}`);
    } else {
      pass("AC2", "create rejects missing RBI-mandatory grievance fields");
    }
  }

  // ===== AC3: duplicate rbi_registration_no -> 409 =====
  {
    const sharedRbi = uniqueRbiNo();
    const first = basePayload({ rbiRegistrationNo: sharedRbi });
    const req1 = makeReq("http://localhost/api/admin/nbfc", "POST", first);
    const res1: Response = await POST(req1);
    if (res1.status !== 200) {
      fail("AC3", "create rejects duplicate rbi_registration_no",
        `seed-create failed status=${res1.status}`);
    } else {
      const second = basePayload({ rbiRegistrationNo: sharedRbi });
      const req2 = makeReq("http://localhost/api/admin/nbfc", "POST", second);
      const res2: Response = await POST(req2);
      const j2 = await res2.json().catch(() => ({}));
      if (res2.status === 409 && j2.error === "rbi_registration_no_already_exists") {
        pass("AC3", "create rejects duplicate rbi_registration_no");
      } else {
        fail("AC3", "create rejects duplicate rbi_registration_no",
          `expected 409 got ${res2.status} body=${JSON.stringify(j2)}`);
      }
    }
  }

  // ===== AC4: GET returns created record =====
  if (createdId !== null) {
    const req = makeReq(
      `http://localhost/api/admin/nbfc/${createdId}`,
      "GET",
    );
    // App Router style: handler accepts (req, ctx) — pass ctx with params Promise
    const res: Response = await GET(req, {
      params: Promise.resolve({ id: String(createdId) }),
    });
    const j = await res.json().catch(() => ({}));
    if (
      res.status === 200 &&
      j.success &&
      j.id === createdId &&
      j.nbfcId === createdNbfcId &&
      j.legalName === createdLegalName
    ) {
      pass("AC4", "read returns previously created master record");
    } else {
      fail("AC4", "read returns previously created master record",
        `status=${res.status} body=${JSON.stringify(j)}`);
    }
  } else {
    fail("AC4", "read returns previously created master record",
      "no createdId from AC1");
  }

  // PATCH used by handler is exercised lightly to confirm it compiles & runs:
  if (createdId !== null) {
    const req = makeReq(
      `http://localhost/api/admin/nbfc/${createdId}`,
      "PATCH",
      { primaryContactName: "Asha Iyer (updated)" },
    );
    const res: Response = await PATCH(req, {
      params: Promise.resolve({ id: String(createdId) }),
    });
    if (res.status !== 200) {
      console.log("  WARN  PATCH smoke: status", res.status);
    } else {
      console.log("  INFO  PATCH smoke: ok");
    }
  }

  // ===== summary =====
  const passed = RESULTS.filter((r) => r.ok).length;
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n${passed}/${RESULTS.length} acceptance criteria passed.`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((f) => f.id).join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("E-003 test runner crashed:", err);
  process.exit(2);
});
