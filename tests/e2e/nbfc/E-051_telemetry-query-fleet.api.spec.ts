/**
 * E-051 — NBFC fleet telemetry query API (BRD §6.2.7) — API tests.
 *
 *   AC1: GET /api/iot/fleet?nbfcId={own}&status=all with NBFC JWT returns 200
 *        with total/online/offline counts matching the tenant's portfolio.
 *   AC2: GET with NBFC JWT for a different nbfcId returns HTTP 403.
 *   AC3: GET with Admin JWT returns 200 for any nbfcId.
 *   AC4: response.alerts only includes telemetry_alerts where resolved_at IS
 *        NULL and serial belongs to the nbfcId portfolio.
 *
 * Auth: triple-guarded test bypass; the bypass accepts an additional
 * `x-nbfc-test-caller-nbfc-id` header to fabricate the NBFC JWT's bound nbfcId.
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
  throw new Error("DATABASE_URL must be set for E-051 API tests");
}
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? "e082-loop-bypass-secret";

function bypassHeaders(opts: {
  userId?: string;
  role?: string;
  callerNbfcId?: string | null;
}) {
  const headers: Record<string, string> = {
    "x-nbfc-test-bypass": TEST_BYPASS_SECRET,
    "x-nbfc-test-user-id": opts.userId ?? randomUUID(),
    "x-nbfc-test-user-role": opts.role ?? "admin",
  };
  if (opts.callerNbfcId !== undefined && opts.callerNbfcId !== null) {
    headers["x-nbfc-test-caller-nbfc-id"] = opts.callerNbfcId;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Per-run state — every fixture goes here so afterAll can wipe them.
// ---------------------------------------------------------------------------
const RUN_TAG = `E051-${Date.now().toString(36)}-${Math.floor(
  Math.random() * 1e6,
)}`;
const createdAssignmentIds: number[] = [];
const createdNbfcIds: number[] = [];
const createdNbfcVarcharIds: string[] = [];
const createdDealerIntIds: number[] = [];
const createdDealerCodes: string[] = [];
const createdSerials: string[] = [];

// counter so generated tags don't collide across helper calls.
let counter = 0;
function nextTag(label: string): string {
  counter += 1;
  return `${RUN_TAG}-${label}-${counter}`.slice(0, 40);
}

async function insertTestNbfc(label: string): Promise<{
  intId: number;
  nbfcId: string;
}> {
  const tag = nextTag(label);
  const nbfcIdStr = tag.slice(0, 50);
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: nbfcIdStr,
      legal_name: `E-051 NBFC ${tag}`,
      short_name: `E051 ${tag.slice(0, 18)}`,
      rbi_registration_no: `RBI-${tag}`.slice(0, 100),
      cin: "U65999MH2026PTC000051",
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
    .returning({ id: schema.nbfc.id, nbfc_id: schema.nbfc.nbfc_id });
  createdNbfcIds.push(row.id);
  createdNbfcVarcharIds.push(row.nbfc_id);
  return { intId: row.id, nbfcId: row.nbfc_id };
}

async function insertTestDealer(): Promise<{ intId: number; code: string }> {
  const tag = nextTag("dlr");
  const code = tag.slice(0, 50).toUpperCase();
  const [row] = await db
    .insert(schema.dealers)
    .values({
      dealer_id: code,
      company_name: `E-051 Dealer ${tag}`,
      company_type: "individual",
      onboarding_status: "active",
      finance_enabled: true,
    })
    .returning({ id: schema.dealers.id });
  createdDealerIntIds.push(row.id);
  createdDealerCodes.push(code);
  return { intId: row.id, code };
}

async function linkDealerToNbfc(opts: {
  dealerIntId: number;
  nbfcIntId: number;
}) {
  const [row] = await db
    .insert(schema.dealerNbfcAssignments)
    .values({
      dealer_id: opts.dealerIntId,
      nbfc_id: opts.nbfcIntId,
      enabled_by: 1,
      status: "active",
    })
    .returning({ id: schema.dealerNbfcAssignments.id });
  createdAssignmentIds.push(row.id);
}

async function insertDevice(opts: {
  dealerCode: string;
  serialSuffix: string;
  online: boolean;
  recentlySeen?: boolean;
}) {
  const tag = nextTag(`bat-${opts.serialSuffix}`);
  const serial = tag.slice(0, 50);
  // Build unique 15-digit imei + device id.
  const stamp =
    Date.now().toString().slice(-9) +
    Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
  const imei = stamp.slice(0, 15);
  const lastSeen = opts.recentlySeen
    ? new Date(Date.now() - 60 * 1000) // 1 min ago — fresh
    : new Date(Date.now() - 60 * 60 * 1000); // 1h ago — stale
  await db.insert(schema.iotDevices).values({
    device_id: `IOT-${imei}`,
    serial_number: serial,
    imei_id: imei,
    dealer_id: opts.dealerCode,
    model: "TEST-MODEL",
    category: "3W",
    device_status: opts.online ? "online" : "offline",
    last_seen: lastSeen,
  });
  createdSerials.push(serial);
  return serial;
}

async function insertAlert(opts: {
  serial: string;
  rule: string;
  severity: string;
  resolved?: boolean;
}) {
  await db.insert(schema.telemetryAlerts).values({
    serial_number: opts.serial,
    rule: opts.rule,
    severity: opts.severity,
    resolved_at: opts.resolved ? new Date() : null,
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
test.afterAll(async () => {
  if (createdSerials.length) {
    await db
      .delete(schema.telemetryAlerts)
      .where(inArray(schema.telemetryAlerts.serial_number, createdSerials))
      .catch(() => {});
    await db
      .delete(schema.iotDevices)
      .where(inArray(schema.iotDevices.serial_number, createdSerials))
      .catch(() => {});
  }
  if (createdAssignmentIds.length) {
    await db
      .delete(schema.dealerNbfcAssignments)
      .where(
        inArray(schema.dealerNbfcAssignments.id, createdAssignmentIds),
      )
      .catch(() => {});
  }
  if (createdDealerIntIds.length) {
    await db
      .delete(schema.dealers)
      .where(inArray(schema.dealers.id, createdDealerIntIds))
      .catch(() => {});
  }
  if (createdNbfcIds.length) {
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
test.describe("E-051 — NBFC fleet telemetry query API", () => {
  test("AC1: GET fleet returns correct counts for NBFC's own portfolio", async ({
    request,
  }) => {
    const { intId: nbfcIntId, nbfcId } = await insertTestNbfc("ac1");
    const { intId: dealerIntId, code: dealerCode } = await insertTestDealer();
    await linkDealerToNbfc({ dealerIntId, nbfcIntId });

    // Portfolio: 2 online (1 fresh, 1 stale -> counts as offline because
    // last_seen too old), 1 offline.
    await insertDevice({
      dealerCode,
      serialSuffix: "ac1-on-fresh",
      online: true,
      recentlySeen: true,
    });
    await insertDevice({
      dealerCode,
      serialSuffix: "ac1-on-stale",
      online: true,
      recentlySeen: false,
    });
    await insertDevice({
      dealerCode,
      serialSuffix: "ac1-off",
      online: false,
      recentlySeen: true,
    });

    const res = await request.get(
      `/api/iot/fleet?nbfcId=${encodeURIComponent(nbfcId)}&status=all`,
      {
        headers: bypassHeaders({
          role: "nbfc_partner",
          callerNbfcId: nbfcId,
        }),
      },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(3);
    expect(body.online).toBe(1); // only the fresh online device qualifies
    expect(body.offline).toBe(2);
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  test("AC2: GET fleet returns 403 when NBFC requests another tenant's portfolio", async ({
    request,
  }) => {
    const { nbfcId: ownNbfcId } = await insertTestNbfc("ac2-own");
    const { nbfcId: otherNbfcId } = await insertTestNbfc("ac2-other");

    const res = await request.get(
      `/api/iot/fleet?nbfcId=${encodeURIComponent(otherNbfcId)}&status=all`,
      {
        headers: bypassHeaders({
          role: "nbfc_partner",
          callerNbfcId: ownNbfcId,
        }),
      },
    );
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("AC3: GET fleet returns 200 for admin on any nbfcId", async ({
    request,
  }) => {
    const { intId: nbfcIntId, nbfcId } = await insertTestNbfc("ac3");
    const { intId: dealerIntId, code: dealerCode } = await insertTestDealer();
    await linkDealerToNbfc({ dealerIntId, nbfcIntId });
    await insertDevice({
      dealerCode,
      serialSuffix: "ac3",
      online: true,
      recentlySeen: true,
    });

    const res = await request.get(
      `/api/iot/fleet?nbfcId=${encodeURIComponent(nbfcId)}&status=all`,
      { headers: bypassHeaders({ role: "admin" }) },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.online).toBe(1);
    expect(body.offline).toBe(0);
  });

  test("AC4: GET fleet alerts excludes resolved and out-of-portfolio alerts", async ({
    request,
  }) => {
    // NBFC A — owns dealer A — owns serials A1, A2.
    const { intId: aIntId, nbfcId: nbfcA } = await insertTestNbfc("ac4-a");
    const dealerA = await insertTestDealer();
    await linkDealerToNbfc({ dealerIntId: dealerA.intId, nbfcIntId: aIntId });
    const a1 = await insertDevice({
      dealerCode: dealerA.code,
      serialSuffix: "ac4-a1",
      online: true,
      recentlySeen: true,
    });
    const a2 = await insertDevice({
      dealerCode: dealerA.code,
      serialSuffix: "ac4-a2",
      online: false,
      recentlySeen: true,
    });

    // NBFC B — owns dealer B — owns serial B1.
    const { intId: bIntId } = await insertTestNbfc("ac4-b");
    const dealerB = await insertTestDealer();
    await linkDealerToNbfc({ dealerIntId: dealerB.intId, nbfcIntId: bIntId });
    const b1 = await insertDevice({
      dealerCode: dealerB.code,
      serialSuffix: "ac4-b1",
      online: true,
      recentlySeen: true,
    });

    // Open alert on A1 — should appear.
    await insertAlert({
      serial: a1,
      rule: "BMS Fault",
      severity: "critical",
      resolved: false,
    });
    // Resolved alert on A2 — should NOT appear (resolved_at IS NOT NULL).
    await insertAlert({
      serial: a2,
      rule: "Low SOC",
      severity: "info",
      resolved: true,
    });
    // Open alert on B1 — out of portfolio for NBFC A; should NOT appear.
    await insertAlert({
      serial: b1,
      rule: "High Temperature",
      severity: "critical",
      resolved: false,
    });

    const res = await request.get(
      `/api/iot/fleet?nbfcId=${encodeURIComponent(nbfcA)}&status=all`,
      {
        headers: bypassHeaders({
          role: "nbfc_partner",
          callerNbfcId: nbfcA,
        }),
      },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.alerts)).toBe(true);
    const serials = (
      body.alerts as Array<{ serial_number: string }>
    ).map((a) => a.serial_number);
    expect(serials).toContain(a1);
    expect(serials).not.toContain(a2); // resolved
    expect(serials).not.toContain(b1); // out of portfolio

    const a1Row = (
      body.alerts as Array<{
        serial_number: string;
        rule: string;
        severity: string;
        triggered_at: string;
      }>
    ).find((a) => a.serial_number === a1);
    expect(a1Row).toBeDefined();
    expect(a1Row!.rule).toBe("BMS Fault");
    expect(a1Row!.severity).toBe("critical");
    expect(typeof a1Row!.triggered_at).toBe("string");
  });
});
