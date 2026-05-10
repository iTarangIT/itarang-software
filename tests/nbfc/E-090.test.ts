/**
 * E-090 — DPDPA consent record persistence + withdrawal endpoint.
 * Standalone runner: tsx tests/nbfc/E-090.test.ts
 *
 * AC1: GET /api/nbfc/dpdpa/consent?lead_id=L1 returns 200 with scopes
 *      including 'loan_processing','risk_assessment','warranty_management',
 *      signed_at, status='active' for an unwithdrawn consent.
 * AC2: POST /api/nbfc/dpdpa/consent/withdraw with valid body returns 200
 *      with status='withdrawn' and withdrawn_at set; subsequent GET returns
 *      status='withdrawn'.
 * AC3: After withdrawal, the underlying consent_records row is NOT deleted
 *      — only nbfc_consent_withdrawals row is added and nbfc_consent_scopes
 *      for telemetry are deactivated.
 * AC4: POST withdraw with withdrawal_channel not in
 *      {'grievance_portal','helpline','email'} returns 400.
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
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS nbfc_consent_scopes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        consent_id varchar(255) NOT NULL,
        scope_key varchar(64) NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        deactivated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS nbfc_consent_scopes_consent_idx ON nbfc_consent_scopes(consent_id)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS nbfc_consent_scopes_consent_scope_uniq ON nbfc_consent_scopes(consent_id, scope_key)`;
    await sql`
      CREATE TABLE IF NOT EXISTS nbfc_consent_withdrawals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id varchar(255) NOT NULL,
        consent_id varchar(255) NOT NULL,
        withdrawal_channel varchar(32) NOT NULL,
        reason text,
        withdrawn_at timestamptz NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS nbfc_consent_withdrawals_lead_idx ON nbfc_consent_withdrawals(lead_id)`;
    await sql`CREATE INDEX IF NOT EXISTS nbfc_consent_withdrawals_consent_idx ON nbfc_consent_withdrawals(consent_id)`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function createTenant(slug: string): Promise<{ id: string; slug: string }> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    const rows = await sql<{ id: string; slug: string }[]>`
      INSERT INTO nbfc_tenants (slug, display_name)
      VALUES (${slug}, ${"E-090 Test Tenant"})
      RETURNING id, slug
    `;
    return rows[0];
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function createLead(lead_id: string): Promise<void> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    await sql`
      INSERT INTO leads (id, lead_source, uploader_id)
      VALUES (${lead_id}, ${"e090_test"}, ${randomUUID()})
      ON CONFLICT (id) DO NOTHING
    `;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function createConsent(
  lead_id: string,
): Promise<{ id: string; lead_id: string }> {
  await createLead(lead_id);
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    const id = `cr-${randomUUID()}`;
    const rows = await sql<{ id: string; lead_id: string }[]>`
      INSERT INTO consent_records (id, lead_id, consent_type, consent_status, signed_at)
      VALUES (${id}, ${lead_id}, ${"dpdpa"}, ${"signed"}, now())
      RETURNING id, lead_id
    `;
    return rows[0];
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function consentRowExists(id: string): Promise<boolean> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM consent_records WHERE id = ${id} LIMIT 1
    `;
    return rows.length === 1;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function run() {
  await ensureSchema();
  const getRoute = await import(
    path.resolve(__dirname, "../../src/app/api/nbfc/dpdpa/consent/route.ts")
  );
  const withdrawRoute = await import(
    path.resolve(
      __dirname,
      "../../src/app/api/nbfc/dpdpa/consent/withdraw/route.ts",
    )
  );

  const tenant = await createTenant(`e090-${randomUUID().slice(0, 8)}`);
  console.log(`  INFO  tenant ${tenant.id} (${tenant.slug})`);

  const NBFC_USER = randomUUID();
  const leadId = `LEAD-${randomUUID().slice(0, 8)}`;
  const consent = await createConsent(leadId);
  console.log(`  INFO  consent ${consent.id} for lead ${leadId}`);

  // ===== AC1: GET returns active scopes =====
  {
    const req = makeReq(
      `http://localhost/api/nbfc/dpdpa/consent?lead_id=${encodeURIComponent(leadId)}`,
      "GET",
      authHeaders({
        tenant_id: tenant.id,
        user_id: NBFC_USER,
        role: "nbfc_risk_manager",
      }),
    );
    const res: Response = await getRoute.GET(req as never);
    const j = await res.json().catch(() => ({}));
    const scopes: string[] = Array.isArray(j.scopes) ? j.scopes : [];
    const haveAll =
      scopes.includes("loan_processing") &&
      scopes.includes("risk_assessment") &&
      scopes.includes("warranty_management");
    if (
      res.status === 200 &&
      j.status === "active" &&
      haveAll &&
      typeof j.signed_at === "string"
    ) {
      pass("AC1", "Consent GET returns scopes and active status");
    } else {
      fail(
        "AC1",
        "Consent GET returns scopes and active status",
        `status=${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC4: invalid channel returns 400 =====
  {
    const req = makeReq(
      "http://localhost/api/nbfc/dpdpa/consent/withdraw",
      "POST",
      authHeaders({
        tenant_id: tenant.id,
        user_id: NBFC_USER,
        role: "nbfc_risk_manager",
      }),
      {
        lead_id: leadId,
        withdrawal_channel: "carrier_pigeon",
        reason: "should be rejected",
      },
    );
    const res: Response = await withdrawRoute.POST(req as never);
    if (res.status === 400) {
      pass("AC4", "Withdraw rejects unknown channel");
    } else {
      const j = await res.json().catch(() => ({}));
      fail(
        "AC4",
        "Withdraw rejects unknown channel",
        `expected 400 got ${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC2: valid withdraw returns 200, subsequent GET => withdrawn =====
  {
    const req = makeReq(
      "http://localhost/api/nbfc/dpdpa/consent/withdraw",
      "POST",
      authHeaders({
        tenant_id: tenant.id,
        user_id: NBFC_USER,
        role: "nbfc_risk_manager",
      }),
      {
        lead_id: leadId,
        withdrawal_channel: "grievance_portal",
        reason: "borrower requested via grievance form",
      },
    );
    const res: Response = await withdrawRoute.POST(req as never);
    const j = await res.json().catch(() => ({}));
    const withdrawOk =
      res.status === 200 &&
      j.status === "withdrawn" &&
      typeof j.withdrawn_at === "string";

    let getOk = false;
    if (withdrawOk) {
      const getReq = makeReq(
        `http://localhost/api/nbfc/dpdpa/consent?lead_id=${encodeURIComponent(leadId)}`,
        "GET",
        authHeaders({
          tenant_id: tenant.id,
          user_id: NBFC_USER,
          role: "nbfc_risk_manager",
        }),
      );
      const getRes: Response = await getRoute.GET(getReq as never);
      const getJ = await getRes.json().catch(() => ({}));
      getOk =
        getRes.status === 200 &&
        getJ.status === "withdrawn" &&
        typeof getJ.withdrawn_at === "string" &&
        getJ.withdrawal_channel === "grievance_portal";
    }

    if (withdrawOk && getOk) {
      pass("AC2", "Withdraw transitions consent to withdrawn");
    } else {
      fail(
        "AC2",
        "Withdraw transitions consent to withdrawn",
        `withdraw=${res.status} body=${JSON.stringify(j)} getOk=${getOk}`,
      );
    }
  }

  // ===== AC3: consent_records row preserved; withdrawal+scope side-effects =====
  {
    const stillExists = await consentRowExists(consent.id);
    const { db } = await import(
      path.resolve(__dirname, "../../src/lib/db/index.ts")
    );
    const schema = await import(
      path.resolve(__dirname, "../../src/lib/db/schema.ts")
    );
    const { eq, and, inArray } = await import("drizzle-orm");

    const withdrawals = await db
      .select()
      .from(schema.nbfcConsentWithdrawals)
      .where(eq(schema.nbfcConsentWithdrawals.consent_id, consent.id));
    const telemetryScopes = await db
      .select()
      .from(schema.nbfcConsentScopes)
      .where(
        and(
          eq(schema.nbfcConsentScopes.consent_id, consent.id),
          inArray(schema.nbfcConsentScopes.scope_key, [
            "risk_assessment",
            "warranty_management",
          ]),
        ),
      );
    const loanProcessing = await db
      .select()
      .from(schema.nbfcConsentScopes)
      .where(
        and(
          eq(schema.nbfcConsentScopes.consent_id, consent.id),
          eq(schema.nbfcConsentScopes.scope_key, "loan_processing"),
        ),
      );

    const allTelemetryDeactivated =
      telemetryScopes.length === 2 &&
      telemetryScopes.every((s: { is_active: boolean }) => !s.is_active);
    const loanStillActive =
      loanProcessing.length === 1 && loanProcessing[0].is_active === true;

    if (
      stillExists &&
      withdrawals.length === 1 &&
      allTelemetryDeactivated &&
      loanStillActive
    ) {
      pass("AC3", "Withdrawal preserves consent record (no retroactive delete)");
    } else {
      fail(
        "AC3",
        "Withdrawal preserves consent record (no retroactive delete)",
        `consent_exists=${stillExists} withdrawals=${withdrawals.length} telemetryDeact=${allTelemetryDeactivated} loanActive=${loanStillActive}`,
      );
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
  console.error("E-090 test runner crashed:", err);
  process.exit(2);
});
