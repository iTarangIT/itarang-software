/**
 * E-047 — Telemetry storage schema (Section 6.2.4) API tests.
 *
 * Schema-only unit. The three ACs all verify migration result by
 * introspecting `information_schema` and exercising the unique constraint
 * via raw INSERTs. No application code (route, component, job) is part of
 * this unit — ingestion (E-046) and summary upsert (E-048) are downstream.
 *
 *   AC1: telemetry_events table exists with bigserial id and all 16 BRD
 *        columns named in section 6.2.4.
 *   AC2: telemetry_daily_summary has a unique constraint on
 *        (serial_number, summary_date).
 *   AC3: Inserting two telemetry_daily_summary rows with the same
 *        (serial_number, summary_date) raises Postgres error 23505 (unique
 *        violation).
 *
 * The test re-uses the same DATABASE_URL pattern as E-091 — it talks
 * straight to Postgres via postgres-js, not through any HTTP route.
 */
import { test, expect } from '@playwright/test';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-047 schema tests');
}

const sql = postgres(DB_URL, { ssl: 'require', prepare: false });

// BRD 6.2.4 — exact column list for telemetry_events. Order is
// informational; we assert by set membership.
const TELEMETRY_EVENTS_COLUMNS = [
  'id',
  'serial_number',
  'imei_id',
  'device_time',
  'server_time',
  'soc_percent',
  'soh_percent',
  'voltage_v',
  'current_a',
  'temperature_c',
  'charge_cycles',
  'gps_lat',
  'gps_lng',
  'daily_km',
  'idle_hours',
  'bms_status',
  'charger_connected',
] as const;

const RUN_ID = `e047-${Date.now()}`;
const seededSummarySerials: string[] = [];

test.afterAll(async () => {
  for (const serial of seededSummarySerials) {
    await sql`DELETE FROM telemetry_daily_summary WHERE serial_number = ${serial}`.catch(
      () => {},
    );
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-047 — Telemetry storage schema', () => {
  test('AC1: telemetry_events table exists with all BRD columns', async () => {
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'telemetry_events'
    `;
    expect(cols.length).toBeGreaterThan(0);
    const found = new Set(cols.map((c) => c.column_name));
    for (const col of TELEMETRY_EVENTS_COLUMNS) {
      expect(found.has(col), `expected telemetry_events.${col} to exist`).toBe(
        true,
      );
    }
    // id is bigserial (bigint backed by sequence).
    const idCol = cols.find((c) => c.column_name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.data_type).toBe('bigint');
  });

  test('AC2: telemetry_daily_summary has unique (serial_number, summary_date)', async () => {
    const tableExists = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'telemetry_daily_summary'
    `;
    expect(tableExists[0].count).toBeGreaterThan(0);

    // Find any unique constraint or unique index whose columns are exactly
    // {serial_number, summary_date}. Drizzle's uniqueIndex generates a
    // unique index in pg_indexes; we accept either.
    const idxRows = await sql<{ indexdef: string; indexname: string }[]>`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'telemetry_daily_summary'
    `;
    const matched = idxRows.find((r) => {
      const def = r.indexdef.toLowerCase();
      return (
        def.includes('unique') &&
        def.includes('serial_number') &&
        def.includes('summary_date')
      );
    });
    expect(
      matched,
      `expected a UNIQUE index on (serial_number, summary_date); got: ${JSON.stringify(idxRows.map((r) => r.indexname))}`,
    ).toBeDefined();
  });

  test('AC3: duplicate (serial_number, summary_date) insert is rejected', async () => {
    const serial = `${RUN_ID}-bat-ac3`;
    seededSummarySerials.push(serial);
    const date = '2026-04-01';

    // First insert: succeeds.
    await sql`
      INSERT INTO telemetry_daily_summary (serial_number, summary_date)
      VALUES (${serial}, ${date})
    `;

    // Second insert with same (serial, date): must fail with 23505 (unique
    // violation). The postgres-js driver throws an error whose .code is
    // the SQLSTATE.
    let caught: { code?: string; message?: string } | null = null;
    try {
      await sql`
        INSERT INTO telemetry_daily_summary (serial_number, summary_date)
        VALUES (${serial}, ${date})
      `;
    } catch (e) {
      caught = e as { code?: string; message?: string };
    }
    expect(caught, 'expected duplicate insert to throw').not.toBeNull();
    // 23505 = unique_violation in SQLSTATE.
    expect(caught!.code).toBe('23505');
  });
});
