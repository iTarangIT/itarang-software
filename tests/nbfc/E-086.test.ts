/**
 * E-086 — Bulk Immobilisation (>5 batteries) gated by dual approval.
 * Standalone runner: tsx tests/nbfc/E-086.test.ts
 *
 * AC1: POST initiate with ≤5 ids returns 400.
 * AC2: POST initiate with 6 ids by 'nbfc_risk_head' returns 200 with
 *      approval_request_id, status='pending_approval', batch_size=6.
 * AC3: POST initiate by user without role 'nbfc_risk_head' returns 403.
 * AC4: After approval by an iTarang Admin user, nbfc_bulk_immobilisation_batches
 *      has one row with executed_count==batch_size and per-loan rows exist
 *      in nbfc_borrower_actions (action_type='battery_immobilisation').
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

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

function authHeaders(opts: {
  tenant_id: string;
  user_id: string;
  role: string;
}) {
  return {
    "Content-Type": "application/json",
    "x-nbfc-test-bypass": "test-bypass",
    "x-nbfc-test-tenant-id": opts.tenant_id,
    "x-nbfc-test-user-id": opts.user_id,
    "x-nbfc-test-user-role": opts.role,
  } as Record<string, string>;
}

function makeReq(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

async function ensureSchema() {
  // Standalone DDL fallback — keeps the test self-contained when the sandbox
  // hasn't had `drizzle-kit push` run yet for the E-086 schema bump.
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS nbfc_bulk_immobilisation_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES nbfc_tenants(id),
        approval_request_id uuid NOT NULL,
        batch_size integer NOT NULL,
        loan_application_ids jsonb NOT NULL,
        executed_at timestamptz,
        executed_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS nbfc_bulk_immob_batches_tenant_idx ON nbfc_bulk_immobilisation_batches(tenant_id)`;
    await sql`CREATE INDEX IF NOT EXISTS nbfc_bulk_immob_batches_approval_idx ON nbfc_bulk_immobilisation_batches(approval_request_id)`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function createTenant(slug: string): Promise<{ id: string; slug: string }> {
  // Insert via raw SQL using ONLY columns guaranteed to exist in the deployed
  // sandbox schema — Drizzle's typed insert otherwise references E-080 columns
  // that may not have landed in the sandbox yet.
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    const rows = await sql<{ id: string; slug: string }[]>`
      INSERT INTO nbfc_tenants (slug, display_name)
      VALUES (${slug}, ${"E-086 Test Tenant"})
      RETURNING id, slug
    `;
    return rows[0];
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function run() {
  await ensureSchema();
  const initiateRoute = await import(
    path.resolve(
      __dirname,
      "../../src/app/api/nbfc/actions/bulk-immobilisation/initiate/route.ts",
    )
  );
  const approveRoute = await import(
    path.resolve(
      __dirname,
      "../../src/app/api/nbfc/dual-approval/requests/[id]/approve/route.ts",
    )
  );
  const { db } = await import(path.resolve(__dirname, "../../src/lib/db/index.ts"));
  const schema = await import(path.resolve(__dirname, "../../src/lib/db/schema.ts"));
  const { eq, and } = await import("drizzle-orm");

  // ---- create a fresh tenant ----
  const tenant = await createTenant(`e086-${randomUUID().slice(0, 8)}`);
  console.log(`  INFO  tenant ${tenant.id} (${tenant.slug})`);

  const RISK_HEAD = randomUUID();
  const VIEWER = randomUUID();
  const ITARANG_ADMIN = randomUUID();

  // ===== AC1: ≤5 ids returns 400 =====
  {
    const ids = ["L1", "L2", "L3", "L4", "L5"];
    const req = makeReq(
      "http://localhost/api/nbfc/actions/bulk-immobilisation/initiate",
      "POST",
      authHeaders({
        tenant_id: tenant.id,
        user_id: RISK_HEAD,
        role: "nbfc_risk_head",
      }),
      {
        loan_application_ids: ids,
        reason_code: "portfolio_dpd_sweep",
        reviewed_evidence_ack: true,
      },
    );
    const res: Response = await initiateRoute.POST(req as never);
    if (res.status === 400) {
      pass("AC1", "Bulk immobilisation rejects batch size ≤ 5");
    } else {
      const j = await res.json().catch(() => ({}));
      fail(
        "AC1",
        "Bulk immobilisation rejects batch size ≤ 5",
        `expected 400 got ${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC3 (run before AC2): non-Risk-Head returns 403 =====
  {
    const ids = ["L1", "L2", "L3", "L4", "L5", "L6"];
    const req = makeReq(
      "http://localhost/api/nbfc/actions/bulk-immobilisation/initiate",
      "POST",
      authHeaders({
        tenant_id: tenant.id,
        user_id: VIEWER,
        role: "viewer",
      }),
      {
        loan_application_ids: ids,
        reason_code: "manual",
        reviewed_evidence_ack: true,
      },
    );
    const res: Response = await initiateRoute.POST(req as never);
    if (res.status === 403) {
      pass("AC3", "Only Risk Head can initiate bulk immobilisation");
    } else {
      const j = await res.json().catch(() => ({}));
      fail(
        "AC3",
        "Only Risk Head can initiate bulk immobilisation",
        `expected 403 got ${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC2: 6 ids by Risk Head returns 200 =====
  let approvalId = "";
  let batchIds: string[] = [];
  {
    batchIds = Array.from({ length: 6 }, (_, i) => `LN-${randomUUID().slice(0, 8)}-${i}`);
    const req = makeReq(
      "http://localhost/api/nbfc/actions/bulk-immobilisation/initiate",
      "POST",
      authHeaders({
        tenant_id: tenant.id,
        user_id: RISK_HEAD,
        role: "nbfc_risk_head",
      }),
      {
        loan_application_ids: batchIds,
        reason_code: "portfolio_dpd_sweep",
        reviewed_evidence_ack: true,
      },
    );
    const res: Response = await initiateRoute.POST(req as never);
    const j = await res.json().catch(() => ({}));
    if (
      res.status === 200 &&
      typeof j.approval_request_id === "string" &&
      j.status === "pending_approval" &&
      j.batch_size === 6 &&
      j.action_type === "bulk_immobilisation"
    ) {
      approvalId = j.approval_request_id;
      pass("AC2", "Bulk immobilisation initiate creates approval for >5 loans");
    } else {
      fail(
        "AC2",
        "Bulk immobilisation initiate creates approval for >5 loans",
        `status=${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC4: iTarang Admin approves → batch executed + per-loan rows =====
  if (approvalId) {
    const req = makeReq(
      `http://localhost/api/nbfc/dual-approval/requests/${approvalId}/approve`,
      "POST",
      authHeaders({
        tenant_id: tenant.id,
        user_id: ITARANG_ADMIN,
        role: "itarang_admin",
      }),
      { comment: "iTarang Admin approves bulk immobilisation per BRD §6.4.3" },
    );
    const res: Response = await approveRoute.POST(req as never, {
      params: Promise.resolve({ id: approvalId }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status !== 200 || j.status !== "approved") {
      fail(
        "AC4",
        "Bulk immobilisation executes only after iTarang Admin approves",
        `approve status=${res.status} body=${JSON.stringify(j)}`,
      );
    } else {
      const batches = await db
        .select()
        .from(schema.nbfcBulkImmobilisationBatches)
        .where(
          eq(schema.nbfcBulkImmobilisationBatches.approval_request_id, approvalId),
        );
      const perLoan = await db
        .select()
        .from(schema.nbfcBorrowerActions)
        .where(
          and(
            eq(schema.nbfcBorrowerActions.tenant_id, tenant.id),
            eq(schema.nbfcBorrowerActions.action_type, "battery_immobilisation"),
          ),
        );
      const matchedPerLoan = perLoan.filter((r) =>
        batchIds.includes(r.loan_sanction_id),
      );
      if (
        batches.length === 1 &&
        batches[0].executed_count === 6 &&
        batches[0].executed_at != null &&
        matchedPerLoan.length === 6
      ) {
        pass(
          "AC4",
          "Bulk immobilisation executes only after iTarang Admin approves",
        );
      } else {
        fail(
          "AC4",
          "Bulk immobilisation executes only after iTarang Admin approves",
          `batches=${JSON.stringify(batches)} per_loan_count=${matchedPerLoan.length}`,
        );
      }
    }
  } else {
    fail(
      "AC4",
      "Bulk immobilisation executes only after iTarang Admin approves",
      "AC2 produced no approval_request_id; AC4 cannot run",
    );
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
  console.error("E-086 test runner crashed:", err);
  process.exit(2);
});
