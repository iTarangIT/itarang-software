/**
 * E-068 — Risk Rule Engine dual-approval commit workflow.
 * Standalone runner: tsx tests/nbfc/E-068.test.ts
 *
 * AC1: POST /request-change with valid MFA returns 200 with
 *      status='pending_second_approval' and creates a row in
 *      nbfc_risk_rule_change_requests.
 * AC2: POST /approve with decision='approve' by a different admin updates
 *      nbfc_risk_rules.current_value to new_value and sets request
 *      status='executed'.
 * AC3: POST /approve returns 403 when approver_id equals requested_by.
 * AC4: On successful approval, an audit_logs row is written with
 *      action='RISK_RULE_CHANGED' carrying before/after values and both
 *      approver IDs.
 * AC5: POST /request-change returns 400 when mfa_token is invalid (shorter
 *      than 6 chars).
 *
 * Auth model: this is the *admin* surface (not the per-tenant NBFC surface),
 * so auth uses x-nbfc-test-admin-id (uuid) + x-nbfc-test-admin-role headers
 * triple-guarded by NBFC_TEST_BYPASS_SECRET.
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

function adminHeaders(opts: { admin_id: string; role?: string }) {
  return {
    "Content-Type": "application/json",
    "x-nbfc-test-bypass": "test-bypass",
    "x-nbfc-test-admin-id": opts.admin_id,
    "x-nbfc-test-admin-role": opts.role ?? "admin",
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

async function ensureRiskRulesSeed() {
  // The /api/admin/nbfc/risk-rules GET handler self-heals from a missing seed.
  // For tests we drive that directly via a raw INSERT to keep the test
  // self-contained and avoid coupling to the GET route.
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    const SEED: { key: string; label: string; unit: string; def: number }[] = [
      { key: "cds_low_medium", label: "CDS: Low/Medium threshold", unit: "score", def: 40 },
      { key: "cds_medium_high", label: "CDS: Medium/High threshold", unit: "score", def: 70 },
      { key: "cds_high_very_high", label: "CDS: High/Very High threshold", unit: "score", def: 85 },
      { key: "emi_overdue_days", label: "EMI Overdue Trigger", unit: "days", def: 30 },
      { key: "usage_drop_pct", label: "Usage Drop Threshold", unit: "pct", def: 40 },
      { key: "geo_shift_km", label: "Geo-Shift Threshold", unit: "km", def: 100 },
      { key: "offline_alert_hours", label: "Offline Alert Threshold", unit: "hours", def: 24 },
      { key: "pci_concern", label: "PCI: Concern threshold", unit: "score", def: 0.4 },
    ];
    for (const r of SEED) {
      await sql`
        INSERT INTO nbfc_risk_rules (rule_key, rule_label, current_value, unit)
        VALUES (${r.key}, ${r.label}, ${r.def}, ${r.unit})
        ON CONFLICT (rule_key) DO NOTHING
      `;
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function resetRule(rule_key: string, value: number) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    await sql`
      UPDATE nbfc_risk_rules SET current_value = ${value}
      WHERE rule_key = ${rule_key}
    `;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function run() {
  await ensureRiskRulesSeed();

  const requestRoute = await import(
    path.resolve(
      __dirname,
      "../../src/app/api/admin/nbfc/risk-rules/request-change/route.ts",
    )
  );
  const approveRoute = await import(
    path.resolve(
      __dirname,
      "../../src/app/api/admin/nbfc/risk-rules/approve/route.ts",
    )
  );
  const { db } = await import(path.resolve(__dirname, "../../src/lib/db/index.ts"));
  const schema = await import(path.resolve(__dirname, "../../src/lib/db/schema.ts"));
  const { eq, and } = await import("drizzle-orm");

  const REQUESTER = randomUUID();
  const RISK_HEAD = randomUUID();
  const RULE = "emi_overdue_days";

  // Reset to a known starting value so this test is idempotent across runs.
  await resetRule(RULE, 30);

  // ===== AC5 (run before AC1 so we don't insert a junk pending row): =====
  // POST /request-change returns 400 when mfa_token < 6 chars.
  {
    const req = makeReq(
      "http://localhost/api/admin/nbfc/risk-rules/request-change",
      "POST",
      adminHeaders({ admin_id: REQUESTER }),
      { rule_key: RULE, new_value: 45, mfa_token: "12345" },
    );
    const res: Response = await requestRoute.POST(req as never);
    if (res.status === 400) {
      pass("AC5", "Request-change rejects invalid MFA with 400");
    } else {
      const j = await res.json().catch(() => ({}));
      fail(
        "AC5",
        "Request-change rejects invalid MFA with 400",
        `expected 400 got ${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC1: valid request returns 200 + creates pending row =====
  let requestId = "";
  {
    const req = makeReq(
      "http://localhost/api/admin/nbfc/risk-rules/request-change",
      "POST",
      adminHeaders({ admin_id: REQUESTER }),
      { rule_key: RULE, new_value: 45, mfa_token: "123456" },
    );
    const res: Response = await requestRoute.POST(req as never);
    const j = await res.json().catch(() => ({}));
    if (
      res.status === 200 &&
      typeof j.request_id === "string" &&
      j.status === "pending_second_approval" &&
      j.rule_key === RULE &&
      Number(j.previous_value) === 30 &&
      Number(j.new_value) === 45
    ) {
      requestId = j.request_id;
      // Assert row exists in DB.
      const rows = await db
        .select()
        .from(schema.nbfcRiskRuleChangeRequests)
        .where(eq(schema.nbfcRiskRuleChangeRequests.id, j.request_id));
      if (rows.length === 1 && rows[0].status === "pending_second_approval") {
        pass(
          "AC1",
          "Request-change creates pending row with valid MFA",
        );
      } else {
        fail(
          "AC1",
          "Request-change creates pending row with valid MFA",
          `pending row not found or wrong status: ${JSON.stringify(rows)}`,
        );
      }
    } else {
      fail(
        "AC1",
        "Request-change creates pending row with valid MFA",
        `status=${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC3: self-approval returns 403 =====
  if (requestId) {
    const req = makeReq(
      "http://localhost/api/admin/nbfc/risk-rules/approve",
      "POST",
      adminHeaders({ admin_id: REQUESTER, role: "admin" }),
      { request_id: requestId, decision: "approve" },
    );
    const res: Response = await approveRoute.POST(req as never);
    if (res.status === 403) {
      pass("AC3", "Approve rejects self-approval with 403");
    } else {
      const j = await res.json().catch(() => ({}));
      fail(
        "AC3",
        "Approve rejects self-approval with 403",
        `expected 403 got ${res.status} body=${JSON.stringify(j)}`,
      );
    }
  } else {
    fail(
      "AC3",
      "Approve rejects self-approval with 403",
      "no request_id from AC1",
    );
  }

  // ===== AC2 + AC4: Risk Head approves — value commits + audit row written =====
  if (requestId) {
    const req = makeReq(
      "http://localhost/api/admin/nbfc/risk-rules/approve",
      "POST",
      adminHeaders({ admin_id: RISK_HEAD, role: "risk_head" }),
      { request_id: requestId, decision: "approve" },
    );
    const res: Response = await approveRoute.POST(req as never);
    const j = await res.json().catch(() => ({}));

    if (res.status === 200 && j.status === "executed") {
      // AC2: nbfc_risk_rules.current_value flipped to 45.
      const ruleRows = await db
        .select()
        .from(schema.nbfcRiskRules)
        .where(eq(schema.nbfcRiskRules.rule_key, RULE));
      const reqRows = await db
        .select()
        .from(schema.nbfcRiskRuleChangeRequests)
        .where(eq(schema.nbfcRiskRuleChangeRequests.id, requestId));
      if (
        ruleRows.length === 1 &&
        Number(ruleRows[0].current_value) === 45 &&
        reqRows.length === 1 &&
        reqRows[0].status === "executed" &&
        reqRows[0].applied_at != null
      ) {
        pass("AC2", "Approve by second admin commits new threshold value");
      } else {
        fail(
          "AC2",
          "Approve by second admin commits new threshold value",
          `rule=${JSON.stringify(ruleRows)} req=${JSON.stringify(reqRows)}`,
        );
      }

      // AC4: audit_logs row with RISK_RULE_CHANGED + before/after + both ids.
      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.entity_type, "nbfc_risk_rule"),
            eq(schema.auditLogs.action, "RISK_RULE_CHANGED"),
          ),
        );
      const matched = audits.find((a: (typeof audits)[number]) => {
        const newData = a.new_data as Record<string, unknown> | null;
        return (
          newData != null &&
          typeof newData === "object" &&
          newData.change_request_id === requestId
        );
      });
      if (matched) {
        const oldData = matched.old_data as Record<string, unknown> | null;
        const newData = matched.new_data as Record<string, unknown> | null;
        const before = Number(oldData?.current_value);
        const after = Number(newData?.current_value);
        const requestedBy = newData?.requested_by;
        const approvedBy = newData?.approved_by;
        if (
          before === 30 &&
          after === 45 &&
          requestedBy === REQUESTER &&
          approvedBy === RISK_HEAD
        ) {
          pass(
            "AC4",
            "Audit log row written with before/after values on approval",
          );
        } else {
          fail(
            "AC4",
            "Audit log row written with before/after values on approval",
            `before=${before} after=${after} req=${String(requestedBy)} app=${String(approvedBy)}`,
          );
        }
      } else {
        fail(
          "AC4",
          "Audit log row written with before/after values on approval",
          `no matching audit row found among ${audits.length} RISK_RULE_CHANGED rows`,
        );
      }
    } else {
      fail(
        "AC2",
        "Approve by second admin commits new threshold value",
        `status=${res.status} body=${JSON.stringify(j)}`,
      );
      fail(
        "AC4",
        "Audit log row written with before/after values on approval",
        "AC2 approve call did not return executed; cannot verify audit row",
      );
    }
  } else {
    fail(
      "AC2",
      "Approve by second admin commits new threshold value",
      "no request_id from AC1",
    );
    fail(
      "AC4",
      "Audit log row written with before/after values on approval",
      "no request_id from AC1",
    );
  }

  // Reset back so re-runs start at a known value.
  await resetRule(RULE, 30);

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
  console.error("E-068 test runner crashed:", err);
  process.exit(2);
});
