/**
 * E-002 — NBFC activation: portal credential issuance.
 * Standalone runner: tsx tests/nbfc/E-002.test.ts
 *
 * Loads DATABASE_URL from keys/sandbox.env (NBFC_ENV_FILE override),
 * triple-guards the test bypass, and invokes the App Router activate handler
 * directly with crafted Requests. Supabase admin and the email queue are
 * stubbed via NBFC_PORTAL_EMAIL_INMEMORY=1 + a global supabaseAdmin override.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ----- env bootstrap -----
const ENV_FILE =
  process.env.NBFC_ENV_FILE ||
  path.resolve(__dirname, "../../../../../keys/sandbox.env");
if (fs.existsSync(ENV_FILE)) {
  const raw = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}
(process.env as Record<string, string | undefined>)["NODE_ENV"] =
  process.env.NODE_ENV || "test";
process.env.NBFC_TEST_BYPASS = "1";
process.env.NBFC_TEST_BYPASS_SECRET = "test-bypass";
process.env.NBFC_PORTAL_EMAIL_INMEMORY = "1";

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

const ADMIN_USER_ID = "00000000-0000-0000-0000-0000000000a2"; // synthetic admin uuid

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "x-nbfc-test-bypass": "test-bypass",
    "x-nbfc-test-user-id": ADMIN_USER_ID,
    "x-nbfc-test-user-role": "admin",
  } as Record<string, string>;
}

function makeReq(url: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: authHeaders() };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

function uniqueRbiNo() {
  const r = (n: number) =>
    Math.floor(Math.random() * 10 ** n).toString().padStart(n, "0");
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
    primaryContactEmail: `e002-${randomUUID().slice(0, 8)}@acmecap.example.com`,
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
  // Supabase round-trip is short-circuited inside the activate route when
  // NBFC_PORTAL_EMAIL_INMEMORY=1 (set above).
  const collection = await import(
    path.resolve(__dirname, "../../src/app/api/admin/nbfc/route.ts")
  );
  const activate = await import(
    path.resolve(__dirname, "../../src/app/api/admin/nbfc/[nbfcId]/activate/route.ts")
  );
  const queueJob = await import(
    path.resolve(__dirname, "../../src/lib/queue/jobs/sendNbfcPortalCredentialsJob.ts")
  );
  const { db } = await import(path.resolve(__dirname, "../../src/lib/db/index.ts"));
  const schema = await import(path.resolve(__dirname, "../../src/lib/db/schema.ts"));
  const { eq } = await import("drizzle-orm");

  // ---- create a fresh NBFC ----
  const payload = basePayload();
  const createReq = makeReq(
    "http://localhost/api/admin/nbfc",
    "POST",
    payload,
  );
  // The collection POST uses the older x-test-admin-* bypass, so re-add headers.
  const oldBypassHeaders = new Headers(createReq.headers);
  oldBypassHeaders.set("x-test-admin-id", "1");
  oldBypassHeaders.set("x-test-admin-secret", "test-bypass");
  const createReq2 = new Request(createReq.url, {
    method: "POST",
    headers: oldBypassHeaders,
    body: JSON.stringify(payload),
  });
  const createRes: Response = await collection.POST(createReq2);
  const createJ = await createRes.json();
  if (createRes.status !== 200 || !createJ.success) {
    fail("setup", "create NBFC", `status=${createRes.status} body=${JSON.stringify(createJ)}`);
    return finish();
  }
  const nbfcId: number = createJ.id;
  console.log(`  INFO  created nbfcId=${nbfcId} status=${createJ.status}`);

  // ===== AC1: activate rejects non-approved NBFC (status='draft') =====
  {
    const req = makeReq(
      `http://localhost/api/admin/nbfc/${nbfcId}/activate`,
      "POST",
      {},
    );
    const res: Response = await activate.POST(req, {
      params: Promise.resolve({ nbfcId: String(nbfcId) }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 409 && j.error === "MUST_BE_APPROVED") {
      pass("AC1", "activate rejects non-approved NBFC");
    } else {
      fail("AC1", "activate rejects non-approved NBFC",
        `expected 409 MUST_BE_APPROVED got ${res.status} body=${JSON.stringify(j)}`);
    }
  }

  // Force status='approved' directly so activate() can succeed.
  await db
    .update(schema.nbfc)
    .set({ status: "approved", approved_by: ADMIN_USER_ID, approved_at: new Date() })
    .where(eq(schema.nbfc.id, nbfcId));

  // ===== AC2: activation flips status=active and writes credential row =====
  let credentialDispatchedTo: string | null = null;
  {
    queueJob.__resetInMemoryNbfcCredentialJobs();
    const req = makeReq(
      `http://localhost/api/admin/nbfc/${nbfcId}/activate`,
      "POST",
      {},
    );
    const res: Response = await activate.POST(req, {
      params: Promise.resolve({ nbfcId: String(nbfcId) }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status !== 200 || !j.ok) {
      fail("AC2", "activate persists status=active and creates credential row",
        `status=${res.status} body=${JSON.stringify(j)}`);
    } else {
      credentialDispatchedTo = j.credentialDispatchedTo ?? null;
      // Verify nbfc.status='active'.
      const [row] = await db
        .select({ status: schema.nbfc.status, activated_at: schema.nbfc.activated_at })
        .from(schema.nbfc)
        .where(eq(schema.nbfc.id, nbfcId))
        .limit(1);
      const creds = await db
        .select({ id: schema.nbfcPortalCredentials.id, status: schema.nbfcPortalCredentials.dispatch_status })
        .from(schema.nbfcPortalCredentials)
        .where(eq(schema.nbfcPortalCredentials.nbfc_id, nbfcId));
      if (
        row?.status === "active" &&
        row.activated_at != null &&
        creds.length === 1 &&
        (creds[0].status === "dispatched" || creds[0].status === "pending")
      ) {
        pass("AC2", "activate persists status=active and creates credential row");
      } else {
        fail("AC2", "activate persists status=active and creates credential row",
          `nbfc.status=${row?.status} activated_at=${row?.activated_at} creds=${JSON.stringify(creds)}`);
      }
    }
  }

  // ===== AC3: enqueues credential email to primary_contact_email =====
  {
    const jobs = queueJob.__inMemoryNbfcCredentialJobs;
    const matching = jobs.filter((j: { nbfcId: number }) => j.nbfcId === nbfcId);
    if (
      matching.length === 1 &&
      matching[0].toEmail === payload.primaryContactEmail &&
      typeof matching[0].password === "string" &&
      matching[0].password.length >= 16
    ) {
      pass("AC3", "activate enqueues credential email to primary_contact_email");
    } else {
      fail("AC3", "activate enqueues credential email to primary_contact_email",
        `jobs=${JSON.stringify(matching)} expected toEmail=${payload.primaryContactEmail}`);
    }
  }

  finish();
}

function finish() {
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
  console.error("E-002 test runner crashed:", err);
  process.exit(2);
});
