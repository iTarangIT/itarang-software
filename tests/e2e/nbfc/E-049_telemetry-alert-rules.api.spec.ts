/**
 * E-049 — Telemetry alert rule engine (BRD §6.2.6) — API tests.
 *
 * Verifies the per-packet evaluator and the offline-scan cron together
 * cover the eight rule fan-out described in BRD 6.2.6:
 *
 *   AC1: BMS Fault             → critical
 *   AC2: High Temperature      → critical
 *   AC3: Low SOC + not charging → info
 *   AC4: Battery Offline       → critical (last_seen > 24h)
 *   AC5: Battery Offline Extended + cds_flagged=true (last_seen > 48h)
 *
 * The per-packet evaluator is invoked via the internal trigger route
 * (`/api/iot/internal/evaluate-packet`) which exists because the
 * upstream telemetry-ingestion endpoint (E-046) is downstream of this
 * unit. The offline-scan cron is invoked via
 * `/api/cron/iot/scan-offline-batteries` with a `?now=` override so
 * stale `last_seen` values can be simulated deterministically without
 * sleeping for 25h or 49h.
 *
 * Tests are isolated by tagging seeded serial_numbers with a per-run
 * prefix; afterAll deletes all alert + iot_devices rows for those
 * serials.
 */
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-049 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

const ADMIN_ID = '00000000-0000-4000-a000-0000000e0049';

function adminBypassHeaders() {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-user-id': ADMIN_ID,
    'x-nbfc-test-user-role': 'admin',
    'content-type': 'application/json',
  };
}

const RUN_TAG = `E049-${Date.now()}`;
const seededSerials: string[] = [];

function newSerial(suffix: string): string {
  // Keep total length <= 50 to fit varchar(50).
  const s = `${RUN_TAG}-${suffix}`.slice(0, 50);
  seededSerials.push(s);
  return s;
}

async function seedDevice(serial: string, lastSeen: Date | null) {
  // imei + device_id must be unique. Derive a stable digit-string from a
  // timestamp + suffix so tests don't collide across the run.
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`.slice(
    0,
    15,
  );
  await db.insert(schema.iotDevices).values({
    device_id: `IOT-${stamp}`,
    serial_number: serial,
    imei_id: stamp,
    dealer_id: 'DLR-E049',
    model: 'TEST-MODEL',
    category: '3W',
    device_status: 'online',
    last_seen: lastSeen,
  });
}

test.afterAll(async () => {
  if (seededSerials.length) {
    await db
      .delete(schema.telemetryAlerts)
      .where(inArray(schema.telemetryAlerts.serial_number, seededSerials))
      .catch(() => {});
    await db
      .delete(schema.iotDevices)
      .where(inArray(schema.iotDevices.serial_number, seededSerials))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-049 — Telemetry alert rule engine', () => {
  test('AC1: BMS fault packet creates critical telemetry_alerts row', async ({
    request,
  }) => {
    const serial = newSerial('ac1');
    const res = await request.post('/api/iot/internal/evaluate-packet', {
      headers: adminBypassHeaders(),
      data: {
        serial_number: serial,
        bms_status: 'fault',
        soc_percent: 80,
        temperature_c: 30,
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.raised).toContain('BMS Fault');

    const rows = await db
      .select()
      .from(schema.telemetryAlerts)
      .where(eq(schema.telemetryAlerts.serial_number, serial));
    expect(rows.length).toBe(1);
    expect(rows[0].rule).toBe('BMS Fault');
    expect(rows[0].severity).toBe('critical');
  });

  test('AC2: High temperature (>55C) packet creates critical alert', async ({
    request,
  }) => {
    const serial = newSerial('ac2');
    const res = await request.post('/api/iot/internal/evaluate-packet', {
      headers: adminBypassHeaders(),
      data: {
        serial_number: serial,
        temperature_c: 60,
        soc_percent: 80,
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.raised).toContain('High Temperature');

    const rows = await db
      .select()
      .from(schema.telemetryAlerts)
      .where(eq(schema.telemetryAlerts.serial_number, serial));
    const ht = rows.find((r) => r.rule === 'High Temperature');
    expect(ht, 'High Temperature row not found').toBeDefined();
    expect(ht!.severity).toBe('critical');
  });

  test('AC3: Low SOC and not charging creates info alert', async ({
    request,
  }) => {
    const serial = newSerial('ac3');
    const res = await request.post('/api/iot/internal/evaluate-packet', {
      headers: adminBypassHeaders(),
      data: {
        serial_number: serial,
        soc_percent: 8,
        charger_connected: false,
        temperature_c: 30,
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.raised).toContain('Low SOC');

    const rows = await db
      .select()
      .from(schema.telemetryAlerts)
      .where(eq(schema.telemetryAlerts.serial_number, serial));
    const low = rows.find((r) => r.rule === 'Low SOC');
    expect(low, 'Low SOC row not found').toBeDefined();
    expect(low!.severity).toBe('info');

    // Sanity: charger_connected=true → no Low SOC alert (negative case).
    const serial2 = newSerial('ac3-charging');
    const res2 = await request.post('/api/iot/internal/evaluate-packet', {
      headers: adminBypassHeaders(),
      data: {
        serial_number: serial2,
        soc_percent: 5,
        charger_connected: true,
        temperature_c: 30,
      },
    });
    expect(res2.status()).toBe(200);
    const rows2 = await db
      .select()
      .from(schema.telemetryAlerts)
      .where(eq(schema.telemetryAlerts.serial_number, serial2));
    expect(
      rows2.find((r) => r.rule === 'Low SOC'),
      'Low SOC must not fire when charger is connected',
    ).toBeUndefined();
  });

  test('AC4: Offline scan emits Battery Offline when last_seen >24h', async ({
    request,
  }) => {
    const serial = newSerial('ac4');
    // last_seen 25 hours ago (just past the 24h threshold but before 48h).
    const lastSeen = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedDevice(serial, lastSeen);

    // Anchor "now" relative to the seeded last_seen so the scan is
    // deterministic regardless of test latency.
    const now = new Date(lastSeen.getTime() + 25 * 60 * 60 * 1000);
    const res = await request.post(
      `/api/cron/iot/scan-offline-batteries?now=${encodeURIComponent(now.toISOString())}`,
      { headers: { 'content-type': 'application/json' } },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await db
      .select()
      .from(schema.telemetryAlerts)
      .where(eq(schema.telemetryAlerts.serial_number, serial));
    const offline = rows.find((r) => r.rule === 'Battery Offline');
    expect(offline, 'Battery Offline row not raised').toBeDefined();
    expect(offline!.severity).toBe('critical');
    expect(offline!.cds_flagged).toBe(false);
    expect(rows.find((r) => r.rule === 'Battery Offline Extended')).toBeUndefined();
  });

  test('AC5: Offline scan emits Battery Offline Extended and flags CDS at >48h', async ({
    request,
  }) => {
    const serial = newSerial('ac5');
    // last_seen 50 hours ago.
    const lastSeen = new Date(Date.now() - 50 * 60 * 60 * 1000);
    await seedDevice(serial, lastSeen);

    const now = new Date(lastSeen.getTime() + 50 * 60 * 60 * 1000);
    const res = await request.post(
      `/api/cron/iot/scan-offline-batteries?now=${encodeURIComponent(now.toISOString())}`,
      { headers: { 'content-type': 'application/json' } },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await db
      .select()
      .from(schema.telemetryAlerts)
      .where(eq(schema.telemetryAlerts.serial_number, serial));
    const ext = rows.find((r) => r.rule === 'Battery Offline Extended');
    expect(ext, 'Battery Offline Extended row not raised').toBeDefined();
    expect(ext!.severity).toBe('critical');
    expect(ext!.cds_flagged).toBe(true);
  });
});
