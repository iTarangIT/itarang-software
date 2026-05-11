/**
 * E-045 — IoT device registration API tests (BRD §6.2.2)
 *
 * AC1: POST /api/iot/register-device with a valid body inserts a new
 *      iot_devices row with device_status='registered' and returns
 *      deviceId 'IOT-{imeiId}'.
 * AC2: Repeated POST with the same serialNumber/imeiId is idempotent —
 *      no duplicate row, returns the existing deviceId.
 * AC3: POST with a malformed imeiId (not 15–20 digits) returns HTTP 422.
 *
 * Auth: triple-guarded admin test bypass (NODE_ENV != production AND
 * NBFC_TEST_BYPASS_SECRET set on the server AND `x-nbfc-test-bypass`
 * header on the request).
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, or } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-045 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function adminBypassHeaders(opts?: { userId?: string; role?: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-user-id': opts?.userId ?? randomUUID(),
    'x-nbfc-test-user-role': opts?.role ?? 'admin',
  };
}

// ---------------------------------------------------------------------------
// Fixtures — generate unique serial/imei per test run to avoid collisions on
// the unique constraints. Cleanup wipes any rows we created.
// ---------------------------------------------------------------------------

function uniqueSuffix(label: string) {
  return `${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 100000)
    .toString(36)
    .padStart(4, '0')}`;
}

function uniqueImei(): string {
  // 15-digit synthetic IMEI; prefix with timestamp + random to avoid clashes.
  const ts = Date.now().toString().slice(-9);
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
  return (ts + rand).slice(0, 15);
}

const createdSerials: string[] = [];
const createdImeis: string[] = [];

test.afterAll(async () => {
  if (createdSerials.length || createdImeis.length) {
    await db
      .delete(schema.iotDevices)
      .where(
        or(
          ...createdSerials.map((s) => eq(schema.iotDevices.serial_number, s)),
          ...createdImeis.map((i) => eq(schema.iotDevices.imei_id, i)),
        ),
      )
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------

test.describe('E-045 — IoT device registration', () => {
  test('AC1: POST register-device creates iot_devices row and returns deviceId', async ({
    request,
  }) => {
    const serial = uniqueSuffix('BAT').toUpperCase();
    const imei = uniqueImei();
    const dealer = uniqueSuffix('DLR').toUpperCase();
    createdSerials.push(serial);
    createdImeis.push(imei);

    const res = await request.post('/api/iot/register-device', {
      headers: adminBypassHeaders(),
      data: {
        serialNumber: serial,
        imeiId: imei,
        dealerId: dealer,
        model: '51.2V-105AH',
        category: '3W',
      },
    });

    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.deviceId).toBe(`IOT-${imei}`);
    expect(body.status).toBe('registered');

    // DB check.
    const rows = await db
      .select()
      .from(schema.iotDevices)
      .where(eq(schema.iotDevices.imei_id, imei));
    expect(rows.length).toBe(1);
    expect(rows[0].device_status).toBe('registered');
    expect(rows[0].serial_number).toBe(serial);
    expect(rows[0].dealer_id).toBe(dealer);
    expect(rows[0].model).toBe('51.2V-105AH');
    expect(rows[0].category).toBe('3W');
    expect(rows[0].registered_at).toBeTruthy();
  });

  test('AC2: POST register-device is idempotent for repeat serial/imei', async ({
    request,
  }) => {
    const serial = uniqueSuffix('BAT').toUpperCase();
    const imei = uniqueImei();
    const dealer = uniqueSuffix('DLR').toUpperCase();
    createdSerials.push(serial);
    createdImeis.push(imei);

    const payload = {
      serialNumber: serial,
      imeiId: imei,
      dealerId: dealer,
      model: '51.2V-105AH',
      category: '3W',
    };

    const first = await request.post('/api/iot/register-device', {
      headers: adminBypassHeaders(),
      data: payload,
    });
    expect(first.status(), await first.text().catch(() => '')).toBe(200);
    const firstBody = await first.json();

    const second = await request.post('/api/iot/register-device', {
      headers: adminBypassHeaders(),
      data: payload,
    });
    expect(second.status(), await second.text().catch(() => '')).toBe(200);
    const secondBody = await second.json();

    expect(secondBody.deviceId).toBe(firstBody.deviceId);
    expect(secondBody.deviceId).toBe(`IOT-${imei}`);
    expect(secondBody.status).toBe('registered');

    // Exactly one row in DB after two calls.
    const rows = await db
      .select()
      .from(schema.iotDevices)
      .where(eq(schema.iotDevices.imei_id, imei));
    expect(rows.length).toBe(1);
  });

  test('AC3: POST register-device rejects malformed imeiId with 422', async ({
    request,
  }) => {
    const serial = uniqueSuffix('BAT').toUpperCase();
    const dealer = uniqueSuffix('DLR').toUpperCase();
    // No DB row should be created — but track so cleanup is harmless.
    createdSerials.push(serial);

    const res = await request.post('/api/iot/register-device', {
      headers: adminBypassHeaders(),
      data: {
        serialNumber: serial,
        imeiId: '12345', // too short — must be 15–20 digits
        dealerId: dealer,
        model: '51.2V-105AH',
        category: '3W',
      },
    });

    expect(res.status(), await res.text().catch(() => '')).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.issues)).toBe(true);

    // Confirm no row was inserted.
    const rows = await db
      .select()
      .from(schema.iotDevices)
      .where(eq(schema.iotDevices.serial_number, serial));
    expect(rows.length).toBe(0);
  });
});
