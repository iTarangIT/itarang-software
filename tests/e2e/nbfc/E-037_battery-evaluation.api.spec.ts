/**
 * E-037 — Battery Evaluation 3-step form API tests (BRD §6.1.7)
 *
 * AC1: POST /api/nbfc/recovery/[id]/evaluation with all 3 valid steps returns
 *      200 and persists an nbfc_battery_evaluations row.
 * AC2: SOH=90, original=100000 -> base_auction_price=67500 (>85% bracket).
 * AC3: SOH=75, original=100000 -> base_auction_price=57500 (70-85% bracket).
 * AC4: step3.reject=true -> rejected=true, base_auction_price=0.
 * AC5: step2.decision='scrap' moves the linked recovery pipeline row's stage
 *      to 'scrap'.
 *
 * Auth uses the canonical triple-guarded test bypass (matches E-035 spec).
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-037 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function bypassHeaders(opts: { tenantId: string; userId: string; role: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-tenant-id': opts.tenantId,
    'x-nbfc-test-user-id': opts.userId,
    'x-nbfc-test-user-role': opts.role,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ROLE = 'recovery_operator';

const ctx: { tenantId: string } = { tenantId: '' };
const createdPipelineIds: string[] = [];
const createdEvaluationIds: string[] = [];

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e037-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-037 Test NBFC ${slug}` })
    .returning();
  return row.id;
}

async function makePipelineRow(tenantId: string): Promise<string> {
  const [row] = await db
    .insert(schema.nbfcRecoveryPipeline)
    .values({
      tenant_id: tenantId,
      battery_serial: `E037-${randomUUID().slice(0, 8)}`,
      stage: 'needs_inspection',
    })
    .returning({ id: schema.nbfcRecoveryPipeline.id });
  createdPipelineIds.push(row.id);
  return row.id;
}

const validBody = (overrides: {
  soh?: number;
  decision?: 'minor_repair' | 'cell_replacement' | 'scrap';
  original_value?: number;
  reject?: boolean;
}) => ({
  step1: {
    soh_percent: overrides.soh ?? 80,
    physical_condition: 'good' as const,
    manufacturing_date: '2023-01-15',
    iot_status: 'online' as const,
    bms_health: 'healthy' as const,
    charger_type: 'AC-2kW',
  },
  step2: {
    decision: overrides.decision ?? ('minor_repair' as const),
    estimated_cost: 1500,
    checklist: {
      terminal_cleaning: true,
      software_recalibration: true,
      warranty_reset: false,
    },
  },
  step3: {
    original_value: overrides.original_value ?? 50000,
    reject: overrides.reject ?? false,
  },
});

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant();
});

test.afterAll(async () => {
  for (const eid of createdEvaluationIds) {
    await db
      .delete(schema.nbfcBatteryEvaluations)
      .where(eq(schema.nbfcBatteryEvaluations.id, eid))
      .catch(() => {});
  }
  for (const pid of createdPipelineIds) {
    await db
      .delete(schema.nbfcBatteryEvaluations)
      .where(eq(schema.nbfcBatteryEvaluations.recovery_pipeline_id, pid))
      .catch(() => {});
    await db
      .delete(schema.nbfcRecoveryPipeline)
      .where(eq(schema.nbfcRecoveryPipeline.id, pid))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe('E-037 — Battery Evaluation 3-step form', () => {
  test('AC1: 3-step submit persists an nbfc_battery_evaluations row', async ({
    request,
  }) => {
    const pipelineId = await makePipelineRow(ctx.tenantId);

    const res = await request.post(
      `/api/nbfc/recovery/${pipelineId}/evaluation`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
        data: validBody({ soh: 80, original_value: 50000 }),
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.evaluation_id).toBeTruthy();
    expect(typeof body.base_auction_price).toBe('number');
    expect(body.rejected).toBe(false);
    createdEvaluationIds.push(body.evaluation_id);

    const rows = await db
      .select()
      .from(schema.nbfcBatteryEvaluations)
      .where(eq(schema.nbfcBatteryEvaluations.id, body.evaluation_id));
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(ctx.tenantId);
    expect(rows[0].recovery_pipeline_id).toBe(pipelineId);
    expect(rows[0].rejected).toBe(false);
  });

  test('AC2: SOH 90 + original 100000 -> base_auction_price 67500', async ({
    request,
  }) => {
    const pipelineId = await makePipelineRow(ctx.tenantId);

    const res = await request.post(
      `/api/nbfc/recovery/${pipelineId}/evaluation`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
        data: validBody({ soh: 90, original_value: 100000 }),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.base_auction_price).toBe(67500);
    expect(body.rejected).toBe(false);
    createdEvaluationIds.push(body.evaluation_id);
  });

  test('AC3: SOH 75 + original 100000 -> base_auction_price 57500', async ({
    request,
  }) => {
    const pipelineId = await makePipelineRow(ctx.tenantId);

    const res = await request.post(
      `/api/nbfc/recovery/${pipelineId}/evaluation`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
        data: validBody({ soh: 75, original_value: 100000 }),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.base_auction_price).toBe(57500);
    expect(body.rejected).toBe(false);
    createdEvaluationIds.push(body.evaluation_id);
  });

  test('AC4: reject=true -> rejected=true and base_auction_price=0', async ({
    request,
  }) => {
    const pipelineId = await makePipelineRow(ctx.tenantId);

    const res = await request.post(
      `/api/nbfc/recovery/${pipelineId}/evaluation`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
        data: validBody({ soh: 80, original_value: 100000, reject: true }),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.rejected).toBe(true);
    expect(body.base_auction_price).toBe(0);
    createdEvaluationIds.push(body.evaluation_id);
  });

  test("AC5: scrap decision moves pipeline row stage to 'scrap'", async ({
    request,
  }) => {
    const pipelineId = await makePipelineRow(ctx.tenantId);

    const res = await request.post(
      `/api/nbfc/recovery/${pipelineId}/evaluation`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId: randomUUID(),
          role: ROLE,
        }),
        data: validBody({ soh: 60, decision: 'scrap', original_value: 50000 }),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    createdEvaluationIds.push(body.evaluation_id);

    const pipelineRows = await db
      .select({ stage: schema.nbfcRecoveryPipeline.stage })
      .from(schema.nbfcRecoveryPipeline)
      .where(
        and(
          eq(schema.nbfcRecoveryPipeline.id, pipelineId),
          eq(schema.nbfcRecoveryPipeline.tenant_id, ctx.tenantId),
        ),
      );
    expect(pipelineRows[0]?.stage).toBe('scrap');
  });
});
