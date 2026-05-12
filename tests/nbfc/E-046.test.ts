/**
 * E-046 — Telemetry ingestion API.
 *
 * Standalone runner: tsx tests/nbfc/E-046.test.ts
 *
 * Loads DATABASE_URL from keys/sandbox.env (NBFC_ENV_FILE override). The
 * test invokes the App Router POST handler directly against a freshly seeded
 * inventory + iot_devices row and asserts telemetry_events / iot_devices /
 * telemetry_daily_summary side-effects.
 *
 * Acceptance criteria covered:
 *   AC1 valid packet → 200 { accepted: true } + telemetry_events row inserted
 *   AC2 missing/invalid X-Device-Token → 401 { error: 'DEVICE_AUTH_FAILED' }
 *   AC3 timestamp >5 min skew → 422 { field: 'timestamp' }
 *   AC4 soc_percent=120 → 422 { error: 'INVALID_PAYLOAD', field: 'soc_percent' }
 *   AC5 successful ingest → iot_devices.last_seen + device_status='online'
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
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
if (!process.env.NBFC_TEST_BYPASS_SECRET) {
  process.env.NBFC_TEST_BYPASS_SECRET = "test-bypass";
}
process.env.IOT_DEVICE_TOKEN_SECRET = "test-iot-secret-e046";

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

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signDeviceToken(imeiId: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: imeiId, iat: Math.floor(Date.now() / 1000) }),
  );
  const sig = crypto
    .createHmac("sha256", process.env.IOT_DEVICE_TOKEN_SECRET as string)
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${b64url(sig)}`;
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

function basePacket(opts: {
  serialNumber: string;
  imeiId: string;
  timestamp?: string;
  socPercent?: number;
}) {
  return {
    serialNumber: opts.serialNumber,
    imeiId: opts.imeiId,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    soc_percent: opts.socPercent ?? 74,
    soh_percent: 91,
    voltage_v: 51.8,
    current_a: 12.4,
    temperature_c: 32.1,
    charge_cycles: 143,
    gps: { lat: 25.4358, lng: 81.8463, accuracy_m: 15 },
    daily_km: 28.4,
    idle_hours: 6.2,
    bms_status: "normal" as const,
    charger_connected: false,
  };
}

async function seed(serialNumber: string, imeiId: string) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    // Clean any prior fixtures for this serial.
    await sql`DELETE FROM telemetry_events WHERE serial_number = ${serialNumber}`;
    await sql`DELETE FROM telemetry_daily_summary WHERE serial_number = ${serialNumber}`;
    await sql`DELETE FROM iot_devices WHERE serial_number = ${serialNumber}`;
    await sql`DELETE FROM inventory WHERE serial_number = ${serialNumber}`;

    // Seed an inventory row with iot_imei_no set (this is how the route
    // recognises the asset as IoT-enabled — see route comment).
    await sql`
      INSERT INTO inventory (serial_number, iot_imei_no, created_at, updated_at)
      VALUES (${serialNumber}, ${imeiId}, NOW(), NOW())
    `;

    // Pre-register iot_devices so the AC5 update path is unambiguous.
    await sql`
      INSERT INTO iot_devices
        (device_id, serial_number, imei_id, dealer_id, model, category,
         device_status, registered_at, updated_at)
      VALUES
        (${"IOT-" + imeiId}, ${serialNumber}, ${imeiId}, ${"D-TEST"},
         ${"TEST-MODEL"}, ${"battery"}, ${"registered"}, NOW(), NOW())
    `;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function cleanup(serialNumber: string) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL as string, { ssl: "require" });
  try {
    await sql`DELETE FROM telemetry_events WHERE serial_number = ${serialNumber}`;
    await sql`DELETE FROM telemetry_daily_summary WHERE serial_number = ${serialNumber}`;
    await sql`DELETE FROM iot_devices WHERE serial_number = ${serialNumber}`;
    await sql`DELETE FROM inventory WHERE serial_number = ${serialNumber}`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function run() {
  const route = await import(
    path.resolve(__dirname, "../../src/app/api/iot/ingest/route.ts")
  );
  const { db } = await import(path.resolve(__dirname, "../../src/lib/db/index.ts"));
  const schema = await import(path.resolve(__dirname, "../../src/lib/db/schema.ts"));
  const { eq } = await import("drizzle-orm");

  // Generate per-run fixtures so reruns don't collide.
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const SERIAL = `BAT-E046-${suffix}`;
  // 15 digits, deterministic from suffix to keep imei valid format.
  const IMEI = `35400${suffix.replace(/[^0-9]/g, "0").padEnd(10, "0").slice(0, 10)}`.slice(0, 15);
  // Fall back if regex doesn't produce digits-only.
  const SAFE_IMEI = /^\d{15}$/.test(IMEI)
    ? IMEI
    : `354000${Date.now().toString().slice(-9)}`;

  await seed(SERIAL, SAFE_IMEI);
  const validToken = signDeviceToken(SAFE_IMEI);

  const headers = (overrides: Record<string, string> = {}) => ({
    "Content-Type": "application/json",
    "X-Device-IMEI": SAFE_IMEI,
    "X-Device-Token": validToken,
    ...overrides,
  });

  // ===== AC4: out-of-range soc_percent → 422 with field='soc_percent' =====
  // (Run BEFORE AC1 so we don't pollute the day's telemetry_events.)
  {
    const packet = basePacket({
      serialNumber: SERIAL,
      imeiId: SAFE_IMEI,
      socPercent: 120,
    });
    const req = makeReq(
      "http://localhost/api/iot/ingest",
      "POST",
      headers(),
      packet,
    );
    const res: Response = await route.POST(req as never);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      res.status === 422 &&
      j.error === "INVALID_PAYLOAD" &&
      j.field === "soc_percent"
    ) {
      pass("AC4", "Out-of-range soc_percent rejected with 422");
    } else {
      fail(
        "AC4",
        "Out-of-range soc_percent rejected with 422",
        `status=${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC2: invalid token → 401 DEVICE_AUTH_FAILED =====
  {
    const packet = basePacket({ serialNumber: SERIAL, imeiId: SAFE_IMEI });
    const req = makeReq(
      "http://localhost/api/iot/ingest",
      "POST",
      headers({ "X-Device-Token": "not-a-valid-jwt" }),
      packet,
    );
    const res: Response = await route.POST(req as never);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401 && j.error === "DEVICE_AUTH_FAILED") {
      pass("AC2", "Invalid X-Device-Token rejected with 401");
    } else {
      fail(
        "AC2",
        "Invalid X-Device-Token rejected with 401",
        `status=${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC3: stale timestamp (>5 min) → 422 field='timestamp' =====
  {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const packet = basePacket({
      serialNumber: SERIAL,
      imeiId: SAFE_IMEI,
      timestamp: stale,
    });
    const req = makeReq(
      "http://localhost/api/iot/ingest",
      "POST",
      headers(),
      packet,
    );
    const res: Response = await route.POST(req as never);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 422 && j.field === "timestamp") {
      pass("AC3", "Stale packet (>5 min) rejected with 422");
    } else {
      fail(
        "AC3",
        "Stale packet (>5 min) rejected with 422",
        `status=${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC1: valid packet → 200 + telemetry_events row =====
  let validResponseAccepted = false;
  {
    const packet = basePacket({ serialNumber: SERIAL, imeiId: SAFE_IMEI });
    const req = makeReq(
      "http://localhost/api/iot/ingest",
      "POST",
      headers(),
      packet,
    );
    const res: Response = await route.POST(req as never);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.status === 200 && j.accepted === true) {
      validResponseAccepted = true;
      const rows = await db
        .select()
        .from(schema.telemetryEvents)
        .where(eq(schema.telemetryEvents.serial_number, SERIAL));
      if (rows.length >= 1) {
        const r = rows[0] as Record<string, unknown>;
        if (
          r.imei_id === SAFE_IMEI &&
          Number(r.soc_percent) === 74 &&
          Number(r.soh_percent) === 91
        ) {
          pass(
            "AC1",
            "Valid packet returns 200 and persists telemetry_events row",
          );
        } else {
          fail(
            "AC1",
            "Valid packet returns 200 and persists telemetry_events row",
            `row mismatch: ${JSON.stringify(r)}`,
          );
        }
      } else {
        fail(
          "AC1",
          "Valid packet returns 200 and persists telemetry_events row",
          "no telemetry_events row found after insert",
        );
      }
    } else {
      fail(
        "AC1",
        "Valid packet returns 200 and persists telemetry_events row",
        `status=${res.status} body=${JSON.stringify(j)}`,
      );
    }
  }

  // ===== AC5: iot_devices.last_seen + device_status='online' =====
  if (validResponseAccepted) {
    const rows = await db
      .select()
      .from(schema.iotDevices)
      .where(eq(schema.iotDevices.serial_number, SERIAL));
    if (rows.length === 1) {
      const r = rows[0] as Record<string, unknown>;
      const lastSeen =
        r.last_seen instanceof Date
          ? r.last_seen
          : r.last_seen
            ? new Date(r.last_seen as string)
            : null;
      if (
        r.device_status === "online" &&
        lastSeen instanceof Date &&
        !Number.isNaN(lastSeen.getTime())
      ) {
        pass(
          "AC5",
          "Successful ingest updates iot_devices.last_seen and device_status='online'",
        );
      } else {
        fail(
          "AC5",
          "Successful ingest updates iot_devices.last_seen and device_status='online'",
          `device_status=${String(r.device_status)} last_seen=${String(r.last_seen)}`,
        );
      }
    } else {
      fail(
        "AC5",
        "Successful ingest updates iot_devices.last_seen and device_status='online'",
        `expected exactly 1 iot_devices row for ${SERIAL}, got ${rows.length}`,
      );
    }
  } else {
    fail(
      "AC5",
      "Successful ingest updates iot_devices.last_seen and device_status='online'",
      "AC1 did not succeed; cannot verify cached fields",
    );
  }

  await cleanup(SERIAL);

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
  console.error("E-046 test runner crashed:", err);
  process.exit(2);
});
