/**
 * E-006 — RBI CoR expiry alert (60-day window) — API tests.
 *
 * AC1: GET /api/admin/nbfc/cor-expiry-alerts returns NBFCs whose
 *      cor_expiry_date is within the next 60 days, with daysToExpiry
 *      computed correctly.
 * AC2: GET excludes NBFCs whose cor_expiry_date is more than 60 days
 *      away.
 * AC3: Running the cor-expiry job twice on the same day for the same
 *      NBFC inserts only one row into nbfc_cor_expiry_alerts.
 *
 * Tests are isolated by tagging seeded NBFCs with `nbfc_id` strings
 * prefixed `NBFC-E006-`. Cleanup deletes the alert ledger rows and the
 * seeded NBFC rows in afterAll.
 */
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, like, inArray } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-006 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function adminBypassHeaders(adminId: number, role = 'admin') {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-admin-id': String(adminId),
    'x-nbfc-test-admin-role': role,
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ADMIN_NUMERIC_ID = 90006;
const RUN_TAG = `E006-${Date.now()}`;
const seededNbfcIds: number[] = [];

async function seedNbfc(opts: {
  shortName: string;
  corExpiryDate: string | null;
}): Promise<number> {
  const stamp = `${RUN_TAG}-${seededNbfcIds.length}`;
  const [row] = await db
    .insert(schema.nbfc)
    .values({
      nbfc_id: `NBFC-${stamp}`,
      legal_name: `E-006 ${opts.shortName} Pvt Ltd`,
      short_name: opts.shortName,
      rbi_registration_no: `RBI-${stamp}`,
      cin: `CIN-${stamp}`.slice(0, 25),
      gst_number: `GST-${stamp}`.slice(0, 20),
      pan_number: `PAN${stamp}`.slice(0, 20),
      nbfc_type: 'NBFC-ND',
      registered_address: { line1: 'test', city: 'BLR', pincode: '560001' },
      active_geographies: ['KA'],
      primary_contact_name: 'Test',
      primary_contact_email: `e006+${stamp}@test.local`,
      primary_contact_phone: '9999999999',
      grievance_officer_name: 'Test Grievance',
      grievance_helpline: '1800000000',
      grievance_url: 'https://test.local/grievance',
      partnership_date: todayIso(),
      cor_expiry_date: opts.corExpiryDate,
      status: 'draft',
      created_by: ADMIN_NUMERIC_ID,
    })
    .returning({ id: schema.nbfc.id });
  seededNbfcIds.push(row.id);
  return row.id;
}

test.afterAll(async () => {
  if (seededNbfcIds.length > 0) {
    await db
      .delete(schema.nbfcCorExpiryAlerts)
      .where(inArray(schema.nbfcCorExpiryAlerts.nbfc_id, seededNbfcIds))
      .catch(() => {});
    await db
      .delete(schema.nbfc)
      .where(inArray(schema.nbfc.id, seededNbfcIds))
      .catch(() => {});
  }
  // belt-and-braces — wipe any leftover NBFCs by run tag
  await db
    .delete(schema.nbfc)
    .where(like(schema.nbfc.nbfc_id, `NBFC-${RUN_TAG}-%`))
    .catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-006 — NBFC CoR expiry alert', () => {
  test('AC1: lists NBFCs within the 60-day window with correct daysToExpiry', async ({
    request,
  }) => {
    const today = todayIso();
    const expiry = addDays(today, 30);
    const nbfcId = await seedNbfc({
      shortName: 'AC1Co',
      corExpiryDate: expiry,
    });

    const res = await request.get('/api/admin/nbfc/cor-expiry-alerts', {
      headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);

    const hit = body.items.find(
      (i: { nbfcId: number }) => i.nbfcId === nbfcId,
    );
    expect(hit, `expected nbfc ${nbfcId} in response`).toBeTruthy();
    expect(hit.shortName).toBe('AC1Co');
    expect(hit.corExpiryDate).toBe(expiry);
    expect(hit.daysToExpiry).toBe(30);
  });

  test('AC2: excludes NBFCs whose CoR expiry is beyond the window', async ({
    request,
  }) => {
    const today = todayIso();
    const farExpiry = addDays(today, 120); // outside default 60-day window
    const farNbfcId = await seedNbfc({
      shortName: 'AC2Far',
      corExpiryDate: farExpiry,
    });

    // Default window=60: far NBFC must be excluded.
    const res60 = await request.get('/api/admin/nbfc/cor-expiry-alerts', {
      headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
    });
    expect(res60.status()).toBe(200);
    const body60 = await res60.json();
    const inSixty = body60.items.find(
      (i: { nbfcId: number }) => i.nbfcId === farNbfcId,
    );
    expect(inSixty, 'NBFC at +120d must NOT be in the 60-day window').toBeFalsy();

    // Widen to 180: now it appears.
    const res180 = await request.get(
      '/api/admin/nbfc/cor-expiry-alerts?windowDays=180',
      { headers: adminBypassHeaders(ADMIN_NUMERIC_ID) },
    );
    expect(res180.status()).toBe(200);
    const body180 = await res180.json();
    const inWide = body180.items.find(
      (i: { nbfcId: number }) => i.nbfcId === farNbfcId,
    );
    expect(inWide, 'NBFC at +120d must appear when windowDays=180').toBeTruthy();
    expect(inWide.daysToExpiry).toBe(120);
  });

  test('AC3: cor-expiry job is idempotent per (nbfc_id, expiry_date)', async ({
    request,
  }) => {
    const today = todayIso();
    const expiry = addDays(today, 15);
    const nbfcId = await seedNbfc({
      shortName: 'AC3Idem',
      corExpiryDate: expiry,
    });

    // First run: must insert exactly one ledger row for this nbfc.
    const run1 = await request.get('/api/cron/nbfc-cor-expiry');
    expect(run1.status(), await run1.text().catch(() => '')).toBe(200);
    const run1Body = await run1.json();
    expect(run1Body.ok).toBe(true);
    // The job may pick up other in-window rows too — assert OUR nbfc was alerted.
    const ourFresh1 = run1Body.rows.find(
      (r: { nbfcId: number }) => r.nbfcId === nbfcId,
    );
    expect(ourFresh1).toBeTruthy();
    expect(ourFresh1.daysToExpiry).toBe(15);

    const ledger1 = await db
      .select()
      .from(schema.nbfcCorExpiryAlerts)
      .where(eq(schema.nbfcCorExpiryAlerts.nbfc_id, nbfcId));
    expect(ledger1.length).toBe(1);

    // Second run on the same day: must NOT insert a second row.
    const run2 = await request.get('/api/cron/nbfc-cor-expiry');
    expect(run2.status()).toBe(200);
    const run2Body = await run2.json();
    expect(run2Body.ok).toBe(true);
    const ourFresh2 = run2Body.rows.find(
      (r: { nbfcId: number }) => r.nbfcId === nbfcId,
    );
    expect(
      ourFresh2,
      'second run on same day must not re-alert the same nbfc',
    ).toBeFalsy();

    const ledger2 = await db
      .select()
      .from(schema.nbfcCorExpiryAlerts)
      .where(eq(schema.nbfcCorExpiryAlerts.nbfc_id, nbfcId));
    expect(ledger2.length).toBe(1);
  });
});
