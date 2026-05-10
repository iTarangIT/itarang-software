/**
 * E-050 — Per-battery telemetry query APIs (BRD §6.2.7).
 *
 * Five ACs across four endpoints, all auth-gated by the same triple-guarded
 * NBFC test bypass used by E-027/E-080/E-082.
 *
 * AC1: GET /api/nbfc/iot/battery/{serial}/soc with NBFC JWT for an in-portfolio
 *      serial returns 200 with serial, soc_percent, soh_percent, last_seen,
 *      device_status, freshness.
 * AC2: GET /soc with Dealer JWT for a serial NOT in dealer inventory returns 403.
 * AC3: GET /state with Admin JWT returns the full iot_devices row plus
 *      data_freshness.
 * AC4: GET /history?metric=soc&from=…&to=… returns 200 with points sorted by
 *      date ascending.
 * AC5: GET /daily-summaries?days=30 returns 200 with at most 30 summary rows
 *      ordered by summary_date desc.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql as drizzleSql } from "drizzle-orm";
import * as schema from "../../../src/lib/db/schema";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL must be set for E-050 API tests");
const sql = postgres(DB_URL, { ssl: "require", prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? "e050-loop-bypass-secret";

type Role = "admin" | "nbfc" | "dealer";
function bypassHeaders(opts: {
  role: Role;
  tenantId?: string;
  userId?: string;
  dealerId?: string;
}) {
  const h: Record<string, string> = {
    "x-nbfc-test-bypass": TEST_BYPASS_SECRET,
    "x-nbfc-test-user-role": opts.role,
    "x-nbfc-test-user-id": opts.userId ?? randomUUID(),
  };
  if (opts.tenantId) h["x-nbfc-test-tenant-id"] = opts.tenantId;
  if (opts.dealerId) h["x-nbfc-test-dealer-id"] = opts.dealerId;
  return h;
}

// Test fixtures — created in beforeAll, cleaned up in afterAll.
const ctx: {
  tenantId: string;
  tenantSlug: string;
  dealerId: string;
  otherDealerId: string;
  serialDealer: string;
  serialNbfcOnly: string;
  serialAdminOnly: string;
  imeiCounter: number;
  telemetryTablesExist: boolean;
} = {
  tenantId: "",
  tenantSlug: "",
  dealerId: "",
  otherDealerId: "",
  serialDealer: "",
  serialNbfcOnly: "",
  serialAdminOnly: "",
  imeiCounter: 0,
  telemetryTablesExist: false,
};

function newImei(): string {
  // 15-digit numeric — matches E-045's regex.
  ctx.imeiCounter += 1;
  // Date.now() is 13 digits in 2026 — pair with the counter (last two digits)
  // to guarantee uniqueness even if two calls land in the same millisecond.
  // 13 + 2 = 15 digits exactly.
  const counter = String(ctx.imeiCounter % 100).padStart(2, "0");
  return `${Date.now()}${counter}`.slice(0, 15);
}

// Track the nbfc legal-record id we may seed so afterAll can clean it up.
const seedRefs: { nbfcLegalId: number | null; assignmentDealerInt: number | null } = {
  nbfcLegalId: null,
  assignmentDealerInt: null,
};

test.beforeAll(async () => {
  const stamp = Date.now();
  ctx.tenantSlug = `e050-${stamp}`;
  // Dealer-id used by the dealer-route tests is a varchar (matches
  // iot_devices.dealer_id). For the nbfc-portfolio path we need an INTEGER
  // dealer-id (matches dealer_nbfc_assignments.dealer_id INT) but we keep it
  // representable as a string so iot_devices.dealer_id::text can match.
  const dealerInt = Number(String(stamp).slice(-9));
  seedRefs.assignmentDealerInt = dealerInt;
  ctx.dealerId = `D-E050-${stamp}-A`; // dealer-route happy/unhappy ACs
  ctx.otherDealerId = String(dealerInt); // numeric so the assignment join can match
  ctx.serialDealer = `BAT-E050-DLR-${stamp}`;
  ctx.serialNbfcOnly = `BAT-E050-NBFC-${stamp}`;
  ctx.serialAdminOnly = `BAT-E050-ADM-${stamp}`;

  // Tenant. Slug equals the new nbfc.nbfc_id we'll seed below so the
  // battery-scope dealer-assignment heuristic matches.
  const [tenantRow] = await db
    .insert(schema.nbfcTenants)
    .values({ slug: ctx.tenantSlug, display_name: `E-050 NBFC ${stamp}` })
    .returning();
  ctx.tenantId = tenantRow.id;

  // Seed a fresh nbfc legal record whose nbfc_id matches the tenant slug, so
  // the heuristic in src/lib/nbfc/battery-scope.ts (slug == nbfc.nbfc_id)
  // resolves to this nbfc.id. All other columns get plausible-looking values
  // — they're irrelevant to the battery-scope check but the table has many
  // NOT NULL columns.
  const nbfcInsertRows = (await db.execute(
    drizzleSql`
      insert into nbfc (
        nbfc_id, legal_name, short_name, rbi_registration_no, cin, gst_number,
        pan_number, nbfc_type, registered_address, active_geographies,
        primary_contact_name, primary_contact_email, primary_contact_phone,
        grievance_officer_name, grievance_helpline, grievance_url,
        partnership_date, created_by
      ) values (
        ${ctx.tenantSlug}, ${"E050 Test NBFC " + stamp}, ${ctx.tenantSlug.slice(0, 24)},
        ${"REG-" + stamp}, ${"CIN-" + stamp}, ${"GST" + stamp}, ${"PAN" + String(stamp).slice(-7)},
        ${"NBFC-ICC"}, '{}'::jsonb, '[]'::jsonb,
        ${"E050 Contact"}, ${"e050@example.com"}, ${"9999999999"},
        ${"GRO"}, ${"1800"}, ${"https://example.com/grievance"},
        '2026-01-01', 0
      ) returning id
    `,
  )) as unknown as Array<{ id: number }>;
  seedRefs.nbfcLegalId = nbfcInsertRows[0].id;

  // Seed dealer_nbfc_assignments so the dealer-assignment scoping heuristic
  // sees ctx.otherDealerId as in-portfolio for the tenant.
  await db.execute(
    drizzleSql`
      insert into dealer_nbfc_assignments (dealer_id, nbfc_id, enabled_by, status)
      values (${dealerInt}, ${seedRefs.nbfcLegalId}, 0, 'active')
    `,
  );

  // Three iot_devices rows.
  //   serialDealer       -> dealer_id == ctx.dealerId; visible to admin + the
  //                          ctx.dealerId dealer; NOT in tenant portfolio
  //                          (no assignment for that dealer_id).
  //   serialNbfcOnly     -> dealer_id == ctx.otherDealerId; reachable via
  //                          dealer_nbfc_assignments tenant linkage above.
  //   serialAdminOnly    -> dealer_id == ctx.otherDealerId; visible to admin
  //                          (also visible to the tenant; we use it for AC3
  //                           which is admin-role anyway).
  const baseLastSeen = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago -> "fresh"
  const olderLastSeen = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago -> "idle"
  const staleLastSeen = new Date(Date.now() - 26 * 60 * 60 * 1000); // 26h ago -> "offline"
  await db.insert(schema.iotDevices).values([
    {
      device_id: `IOT-${newImei()}`,
      serial_number: ctx.serialDealer,
      imei_id: newImei(),
      dealer_id: ctx.dealerId,
      model: "E050-MODEL",
      category: "battery",
      device_status: "active",
      last_seen: baseLastSeen,
      soc_percent: 82,
      soh_percent: 95,
    },
    {
      device_id: `IOT-${newImei()}`,
      serial_number: ctx.serialNbfcOnly,
      imei_id: newImei(),
      dealer_id: ctx.otherDealerId,
      model: "E050-MODEL",
      category: "battery",
      device_status: "active",
      last_seen: olderLastSeen,
      soc_percent: 60,
      soh_percent: 90,
    },
    {
      device_id: `IOT-${newImei()}`,
      serial_number: ctx.serialAdminOnly,
      imei_id: newImei(),
      dealer_id: ctx.otherDealerId,
      model: "E050-MODEL",
      category: "battery",
      device_status: "registered",
      last_seen: staleLastSeen,
      soc_percent: 12,
      soh_percent: 80,
    },
  ]);

  // E-047 telemetry tables MUST exist in the same DB before AC4/AC5 can be
  // exercised. Their migration is owned by E-047; we probe pg_tables here so
  // a missing dependency fails-fast with a clear message rather than dumping
  // a generic "relation does not exist" out of the seed insert.
  const telemetryTables = (await db.execute(
    drizzleSql`select tablename from pg_tables where schemaname='public' and tablename in ('telemetry_events','telemetry_daily_summary')`,
  )) as unknown as Array<{ tablename: string }>;
  ctx.telemetryTablesExist = telemetryTables.length === 2;

  if (!ctx.telemetryTablesExist) {
    // AC1/AC2/AC3 do not touch the telemetry tables, so the suite can still
    // exercise three of the five ACs. AC4 and AC5 short-circuit to test.skip
    // below with a clear "blocked on E-047 sandbox migration" message.
    return;
  }

  // telemetry_events for AC4 (history) — 5 packets across `from..to`.
  // Insert in reverse chronological order to prove the route's ASC sort works
  // even when storage order disagrees.
  const day1 = "2026-04-29";
  const day2 = "2026-04-30";
  const day3 = "2026-05-01";
  const events = [
    { device_time: new Date(`${day3}T05:00:00Z`), soc_percent: 90 },
    { device_time: new Date(`${day1}T05:00:00Z`), soc_percent: 60 },
    { device_time: new Date(`${day2}T05:00:00Z`), soc_percent: 75 },
    { device_time: new Date(`${day1}T08:00:00Z`), soc_percent: 65 },
    { device_time: new Date(`${day2}T11:00:00Z`), soc_percent: 80 },
  ];
  await db.insert(schema.telemetryEvents).values(
    events.map((e) => ({
      serial_number: ctx.serialNbfcOnly,
      imei_id: "865000000000001",
      device_time: e.device_time,
      soc_percent: e.soc_percent,
    })),
  );

  // telemetry_daily_summary for AC5 — 35 rows so the route's days=30 cap kicks in.
  const todayMs = Date.UTC(2026, 4 /* May */, 1);
  const summaries = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(todayMs - i * 24 * 60 * 60 * 1000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return {
      serial_number: ctx.serialNbfcOnly,
      summary_date: `${yyyy}-${mm}-${dd}`,
      avg_soc: "70.00",
      total_km: String(40 - i),
      bms_faults: 0,
      packets_received: 100,
    };
  });
  await db.insert(schema.telemetryDailySummary).values(summaries);
});

test.afterAll(async () => {
  // Order matters — children before parents. Telemetry deletes only run when
  // the tables exist (E-047 migration applied to this sandbox).
  if (ctx.telemetryTablesExist) {
    await db
      .delete(schema.telemetryDailySummary)
      .where(eq(schema.telemetryDailySummary.serial_number, ctx.serialNbfcOnly));
    await db
      .delete(schema.telemetryEvents)
      .where(eq(schema.telemetryEvents.serial_number, ctx.serialNbfcOnly));
  }
  for (const s of [ctx.serialDealer, ctx.serialNbfcOnly, ctx.serialAdminOnly]) {
    await db.delete(schema.iotDevices).where(eq(schema.iotDevices.serial_number, s));
  }
  if (seedRefs.nbfcLegalId != null) {
    await db.execute(
      drizzleSql`delete from dealer_nbfc_assignments where nbfc_id = ${seedRefs.nbfcLegalId}`,
    );
    await db.execute(
      drizzleSql`delete from nbfc where id = ${seedRefs.nbfcLegalId}`,
    );
  }
  await db.delete(schema.nbfcTenants).where(eq(schema.nbfcTenants.id, ctx.tenantId));
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe("E-050 — Per-battery telemetry query APIs", () => {
  test("AC1: GET /soc with NBFC JWT for in-portfolio serial returns expected fields", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/nbfc/iot/battery/${ctx.serialNbfcOnly}/soc`,
      { headers: bypassHeaders({ role: "nbfc", tenantId: ctx.tenantId }) },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.serial).toBe(ctx.serialNbfcOnly);
    expect(body).toHaveProperty("soc_percent");
    expect(body).toHaveProperty("soh_percent");
    expect(body).toHaveProperty("last_seen");
    expect(body).toHaveProperty("device_status");
    expect(body).toHaveProperty("freshness");
    expect(["fresh", "stale", "offline"]).toContain(body.freshness);
    expect(typeof body.soc_percent === "number" || body.soc_percent === null).toBe(true);
  });

  test("AC2: GET /soc with Dealer JWT for serial outside dealer inventory returns 403", async ({
    request,
  }) => {
    // Dealer ctx.otherDealerId asks about serialDealer (which belongs to ctx.dealerId).
    const res = await request.get(
      `/api/nbfc/iot/battery/${ctx.serialDealer}/soc`,
      { headers: bypassHeaders({ role: "dealer", dealerId: ctx.otherDealerId }) },
    );
    expect(res.status()).toBe(403);
  });

  test("AC3: GET /state with Admin JWT returns full iot_devices row + data_freshness", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/nbfc/iot/battery/${ctx.serialAdminOnly}/state`,
      { headers: bypassHeaders({ role: "admin" }) },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("device");
    expect(body).toHaveProperty("data_freshness");
    expect(["fresh", "idle", "stale", "offline", "never"]).toContain(body.data_freshness);
    // Full iot_devices row — spot-check enough columns to prove it's the full
    // row, not the trimmed /soc view.
    expect(body.device.serial_number).toBe(ctx.serialAdminOnly);
    expect(body.device).toHaveProperty("device_id");
    expect(body.device).toHaveProperty("imei_id");
    expect(body.device).toHaveProperty("dealer_id");
    expect(body.device).toHaveProperty("model");
    expect(body.device).toHaveProperty("category");
    expect(body.device).toHaveProperty("registered_at");
    expect(body.device).toHaveProperty("updated_at");
    // 26h-old last_seen -> offline.
    expect(body.data_freshness).toBe("offline");
  });

  test("AC4: GET /history?metric=soc&from..to returns sorted points ASC by date", async ({
    request,
  }) => {
    test.skip(
      !ctx.telemetryTablesExist,
      "Blocked on E-047 sandbox migration: telemetry_events / telemetry_daily_summary missing from database-1",
    );
    const res = await request.get(
      `/api/nbfc/iot/battery/${ctx.serialNbfcOnly}/history?metric=soc&from=2026-04-29&to=2026-05-01`,
      { headers: bypassHeaders({ role: "nbfc", tenantId: ctx.tenantId }) },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.serial).toBe(ctx.serialNbfcOnly);
    expect(body.metric).toBe("soc");
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points.length).toBe(5);
    // Ascending by date — every consecutive pair must be non-decreasing.
    for (let i = 1; i < body.points.length; i++) {
      const prev = new Date(body.points[i - 1].date).getTime();
      const cur = new Date(body.points[i].date).getTime();
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
    // First point is the earliest event we seeded.
    expect(new Date(body.points[0].date).toISOString()).toBe(
      new Date("2026-04-29T05:00:00Z").toISOString(),
    );
  });

  test("AC5: GET /daily-summaries?days=30 returns at most 30 rows ordered desc", async ({
    request,
  }) => {
    test.skip(
      !ctx.telemetryTablesExist,
      "Blocked on E-047 sandbox migration: telemetry_events / telemetry_daily_summary missing from database-1",
    );
    const res = await request.get(
      `/api/nbfc/iot/battery/${ctx.serialNbfcOnly}/daily-summaries?days=30`,
      { headers: bypassHeaders({ role: "admin" }) },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.serial).toBe(ctx.serialNbfcOnly);
    expect(Array.isArray(body.summaries)).toBe(true);
    expect(body.summaries.length).toBeLessThanOrEqual(30);
    expect(body.summaries.length).toBe(30);
    // Descending by summary_date.
    for (let i = 1; i < body.summaries.length; i++) {
      const prev = String(body.summaries[i - 1].summary_date);
      const cur = String(body.summaries[i].summary_date);
      expect(cur <= prev).toBe(true);
    }
  });
});
