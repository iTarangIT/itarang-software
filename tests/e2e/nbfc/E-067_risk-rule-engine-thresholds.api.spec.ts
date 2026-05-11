/**
 * E-067 — Risk Rule Engine threshold configuration with impact preview.
 *
 * AC1: GET /api/admin/nbfc/risk-rules returns 200 with all 8 rule entries.
 * AC2: POST /api/admin/nbfc/risk-rules/preview returns affected_accounts and
 *      accounts_moving_to_higher_band as numbers without mutating the
 *      thresholds table.
 * AC3: POST /preview returns 400 when rule_key is not one of the 8 enum
 *      values.
 * AC4: Both endpoints return 403 when called by a non-admin caller.
 */
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-067 API tests');
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

const ADMIN_NUMERIC_ID = 90067;

const EXPECTED_KEYS = [
  'cds_low_medium',
  'cds_medium_high',
  'cds_high_very_high',
  'emi_overdue_days',
  'usage_drop_pct',
  'geo_shift_km',
  'offline_alert_hours',
  'pci_concern',
] as const;

test.afterAll(async () => {
  await sql.end({ timeout: 5 }).catch(() => {});
});

test.describe('E-067 — Risk Rule Engine thresholds', () => {
  test('AC1: GET risk-rules returns all 8 platform thresholds', async ({
    request,
  }) => {
    const res = await request.get('/api/admin/nbfc/risk-rules', {
      headers: adminBypassHeaders(ADMIN_NUMERIC_ID),
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rules)).toBe(true);
    const keys = body.rules.map((r: { key: string }) => r.key).sort();
    expect(keys).toEqual([...EXPECTED_KEYS].sort());
    // Each row must carry numeric current_value and a non-empty label.
    for (const r of body.rules) {
      expect(typeof r.current_value).toBe('number');
      expect(Number.isFinite(r.current_value)).toBe(true);
      expect(typeof r.label).toBe('string');
      expect(r.label.length).toBeGreaterThan(0);
    }
  });

  test('AC2: POST risk-rules/preview returns impact counts and does not mutate', async ({
    request,
  }) => {
    // Snapshot the current_value of cds_low_medium before previewing.
    const beforeRows = await db
      .select()
      .from(schema.nbfcRiskRules)
      .where(eq(schema.nbfcRiskRules.rule_key, 'cds_low_medium'));
    expect(
      beforeRows.length,
      'cds_low_medium row must exist after seed/self-heal',
    ).toBe(1);
    const beforeValue = Number(beforeRows[0].current_value);
    const beforeUpdatedAt = beforeRows[0].updated_at;

    const proposed = beforeValue + 5;
    const res = await request.post('/api/admin/nbfc/risk-rules/preview', {
      headers: {
        ...adminBypassHeaders(ADMIN_NUMERIC_ID),
        'content-type': 'application/json',
      },
      data: { rule_key: 'cds_low_medium', new_value: proposed },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(typeof body.affected_accounts).toBe('number');
    expect(typeof body.accounts_moving_to_higher_band).toBe('number');
    expect(body.affected_accounts).toBeGreaterThanOrEqual(0);
    expect(body.accounts_moving_to_higher_band).toBeGreaterThanOrEqual(0);
    // The "moving to higher band" subset can never exceed the affected total.
    expect(body.accounts_moving_to_higher_band).toBeLessThanOrEqual(
      body.affected_accounts,
    );

    // Mutation guard — the threshold row must be untouched.
    const afterRows = await db
      .select()
      .from(schema.nbfcRiskRules)
      .where(eq(schema.nbfcRiskRules.rule_key, 'cds_low_medium'));
    expect(afterRows.length).toBe(1);
    expect(Number(afterRows[0].current_value)).toBe(beforeValue);
    expect(afterRows[0].updated_at?.toISOString?.() ?? afterRows[0].updated_at).toEqual(
      beforeUpdatedAt?.toISOString?.() ?? beforeUpdatedAt,
    );
  });

  test('AC3: POST risk-rules/preview rejects unknown rule_key with 400', async ({
    request,
  }) => {
    const res = await request.post('/api/admin/nbfc/risk-rules/preview', {
      headers: {
        ...adminBypassHeaders(ADMIN_NUMERIC_ID),
        'content-type': 'application/json',
      },
      data: { rule_key: 'not_a_real_rule', new_value: 42 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json().catch(() => ({}));
    expect(body.ok).toBe(false);
  });

  test('AC4: Risk-rules endpoints reject non-admin caller with 403', async ({
    request,
  }) => {
    // 'dealer' is not in ADMIN_ROLES — must be rejected by resolveAdminActor.
    const headers = adminBypassHeaders(ADMIN_NUMERIC_ID, 'dealer');
    const getRes = await request.get('/api/admin/nbfc/risk-rules', { headers });
    expect(getRes.status()).toBe(403);

    const postRes = await request.post('/api/admin/nbfc/risk-rules/preview', {
      headers: { ...headers, 'content-type': 'application/json' },
      data: { rule_key: 'cds_low_medium', new_value: 50 },
    });
    expect(postRes.status()).toBe(403);
  });
});
