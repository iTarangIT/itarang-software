/**
 * E-048 — Telemetry data freshness classifier API tests (BRD §6.2.5)
 *
 * AC1: GET /api/iot/battery/{serial}/freshness returns freshness='fresh' when
 *      last_seen is 5 minutes before now.
 * AC2: GET /api/iot/battery/{serial}/freshness returns freshness='stale' when
 *      last_seen is 8 hours before now.
 * AC3: GET /api/iot/battery/{serial}/freshness returns freshness='offline'
 *      when last_seen is 30 hours before now.
 * AC4: GET /api/iot/battery/{serial}/freshness returns freshness='never' and
 *      badge='Awaiting first ping' when last_seen is NULL.
 *
 * Auth: admin test bypass (matches E-045 pattern). Each test seeds an
 * iot_devices row directly, asserts the API response, then cleans up.
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
  throw new Error('DATABASE_URL must be set for E-048 API tests');
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
// Per-test fixtures — generate unique serial/imei to avoid unique-constraint
// collisions across parallel runs.
// ---------------------------------------------------------------------------

function uniqueSuffix(label: string) {
  return `${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 100000)
    .toString(36)
    .padStart(4, '0')}`;
}

function uniqueImei(): string {
  const ts = Date.now().toString().slice(-9);
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
  return (ts + rand).slice(0, 15);
}

const createdSerials: string[] = [];
const createdImeis: string[] = [];

async function seedDevice(opts: {
  serial: string;
  imei: string;
  dealer: string;
  last_seen: Date | null;
}) {
  await db.insert(schema.iotDevices).values({
    device_id: `IOT-${opts.imei}`,
    serial_number: opts.serial,
    imei_id: opts.imei,
    dealer_id: opts.dealer,
    model: '51.2V-105AH',
    category: '3W',
    device_status: 'registered',
    last_seen: opts.last_seen,
  });
}

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

test.describe('E-048 — Telemetry data freshness classifier', () => {
  test('AC1: freshness=fresh when last_seen is 5 minutes before now', async ({
    request,
  }) => {
    const serial = uniqueSuffix('BAT').toUpperCase();
    const imei = uniqueImei();
    const dealer = uniqueSuffix('DLR').toUpperCase();
    createdSerials.push(serial);
    createdImeis.push(imei);

    const lastSeen = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    await seedDevice({ serial, imei, dealer, last_seen: lastSeen });

    const res = await request.get(
      `/api/iot/battery/${encodeURIComponent(serial)}/freshness`,
      { headers: adminBypassHeaders() },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();

    expect(body.serial).toBe(serial);
    expect(body.freshness).toBe('fresh');
    expect(body.badge).toBe('Just now');
    expect(typeof body.last_seen).toBe('string');
    // ISO round-trip should match seed value to the millisecond.
    expect(new Date(body.last_seen).getTime()).toBe(lastSeen.getTime());
  });

  test('AC2: freshness=stale when last_seen is 8 hours before now', async ({
    request,
  }) => {
    const serial = uniqueSuffix('BAT').toUpperCase();
    const imei = uniqueImei();
    const dealer = uniqueSuffix('DLR').toUpperCase();
    createdSerials.push(serial);
    createdImeis.push(imei);

    const lastSeen = new Date(Date.now() - 8 * 60 * 60 * 1000); // 8h ago
    await seedDevice({ serial, imei, dealer, last_seen: lastSeen });

    const res = await request.get(
      `/api/iot/battery/${encodeURIComponent(serial)}/freshness`,
      { headers: adminBypassHeaders() },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();

    expect(body.serial).toBe(serial);
    expect(body.freshness).toBe('stale');
    expect(body.badge).toMatch(/^\d+h ago \(stale\)$/);
    // 8h ago should produce "8h ago (stale)" (allow 7 in case of ms slippage,
    // but not <7 / >8).
    const hoursMatch = body.badge.match(/^(\d+)h/);
    expect(hoursMatch).not.toBeNull();
    const hours = Number(hoursMatch![1]);
    expect(hours).toBeGreaterThanOrEqual(7);
    expect(hours).toBeLessThanOrEqual(8);
  });

  test('AC3: freshness=offline when last_seen is 30 hours before now', async ({
    request,
  }) => {
    const serial = uniqueSuffix('BAT').toUpperCase();
    const imei = uniqueImei();
    const dealer = uniqueSuffix('DLR').toUpperCase();
    createdSerials.push(serial);
    createdImeis.push(imei);

    const lastSeen = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30h ago
    await seedDevice({ serial, imei, dealer, last_seen: lastSeen });

    const res = await request.get(
      `/api/iot/battery/${encodeURIComponent(serial)}/freshness`,
      { headers: adminBypassHeaders() },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();

    expect(body.serial).toBe(serial);
    expect(body.freshness).toBe('offline');
    expect(body.badge).toBe('Offline >24h');
  });

  test('AC4: freshness=never when last_seen is NULL', async ({ request }) => {
    const serial = uniqueSuffix('BAT').toUpperCase();
    const imei = uniqueImei();
    const dealer = uniqueSuffix('DLR').toUpperCase();
    createdSerials.push(serial);
    createdImeis.push(imei);

    await seedDevice({ serial, imei, dealer, last_seen: null });

    const res = await request.get(
      `/api/iot/battery/${encodeURIComponent(serial)}/freshness`,
      { headers: adminBypassHeaders() },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();

    expect(body.serial).toBe(serial);
    expect(body.freshness).toBe('never');
    expect(body.badge).toBe('Awaiting first ping');
    expect(body.last_seen).toBeNull();
  });
});
