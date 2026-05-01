/**
 * E-036 — Recovery pipeline stage management API tests (BRD §6.1.7)
 *
 * AC1: GET /api/nbfc/recovery returns 200 with paginated items array
 *      containing id, battery_serial, stage, estimated_recovery_value,
 *      updated_at.
 * AC2: GET with ?stage=refurbishable returns only rows whose stage equals
 *      'refurbishable'.
 * AC3: PATCH /api/nbfc/recovery/[id]/stage with a valid target stage updates
 *      the row and writes an nbfc_audit_log row.
 * AC4: PATCH attempting to transition from 'needs_inspection' directly to
 *      'resold' returns 400.
 *
 * Auth uses the canonical triple-guarded test bypass.
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
  throw new Error('DATABASE_URL must be set for E-036 API tests');
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
const createdTenantIds: string[] = [];

async function createTenant(): Promise<string> {
  const slug = `e036-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-036 Test NBFC ${slug}` })
    .returning();
  createdTenantIds.push(row.id);
  return row.id;
}

async function makePipelineRow(opts: {
  tenantId: string;
  stage: string;
  value?: number;
}): Promise<string> {
  const [row] = await db
    .insert(schema.nbfcRecoveryPipeline)
    .values({
      tenant_id: opts.tenantId,
      battery_serial: `E036-${randomUUID().slice(0, 8)}`,
      stage: opts.stage,
      estimated_recovery_value:
        opts.value !== undefined ? opts.value.toFixed(2) : null,
    })
    .returning({ id: schema.nbfcRecoveryPipeline.id });
  createdPipelineIds.push(row.id);
  return row.id;
}

test.beforeAll(async () => {
  ctx.tenantId = await createTenant();
});

test.afterAll(async () => {
  // 1. Audit-log rows referencing our pipeline ids.
  for (const pid of createdPipelineIds) {
    await db
      .delete(schema.nbfcAuditLog)
      .where(eq(schema.nbfcAuditLog.action_id, pid))
      .catch(() => {});
  }
  // 2. Pipeline rows.
  for (const pid of createdPipelineIds) {
    await db
      .delete(schema.nbfcRecoveryPipeline)
      .where(eq(schema.nbfcRecoveryPipeline.id, pid))
      .catch(() => {});
  }
  // 3. Tenants.
  for (const tid of createdTenantIds) {
    await db
      .delete(schema.nbfcTenants)
      .where(eq(schema.nbfcTenants.id, tid))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe('E-036 — Recovery pipeline stage management', () => {
  test('AC1: GET returns 200 with paginated items shape', async ({
    request,
  }) => {
    // Seed three rows on the caller tenant.
    await makePipelineRow({ tenantId: ctx.tenantId, stage: 'needs_inspection', value: 12000 });
    await makePipelineRow({ tenantId: ctx.tenantId, stage: 'refurbishable', value: 9500 });
    await makePipelineRow({ tenantId: ctx.tenantId, stage: 'scrap' });

    const userId = randomUUID();
    const res = await request.get('/api/nbfc/recovery?page=1&page_size=50', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId,
        role: ROLE,
      }),
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.page).toBe(1);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBeGreaterThanOrEqual(3);

    // Each item has the required shape
    for (const item of body.items) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.battery_serial).toBe('string');
      expect(typeof item.stage).toBe('string');
      // estimated_recovery_value can be number or null
      expect(['number', 'object']).toContain(typeof item.estimated_recovery_value);
      expect(typeof item.updated_at).toBe('string');
    }
  });

  test('AC2: GET ?stage=refurbishable filters to that stage only', async ({
    request,
  }) => {
    // Seed: one refurbishable + one in another stage to prove the filter.
    const refurbId = await makePipelineRow({
      tenantId: ctx.tenantId,
      stage: 'refurbishable',
      value: 7000,
    });
    await makePipelineRow({
      tenantId: ctx.tenantId,
      stage: 'needs_inspection',
    });

    const userId = randomUUID();
    const res = await request.get(
      '/api/nbfc/recovery?stage=refurbishable&page=1&page_size=50',
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: ROLE,
        }),
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    for (const item of body.items) {
      expect(item.stage).toBe('refurbishable');
    }
    const ids = body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(refurbId);
  });

  test('AC3: PATCH with a valid target stage updates the row and audits', async ({
    request,
  }) => {
    const pipelineId = await makePipelineRow({
      tenantId: ctx.tenantId,
      stage: 'needs_inspection',
      value: 8000,
    });
    const userId = randomUUID();

    const res = await request.patch(`/api/nbfc/recovery/${pipelineId}/stage`, {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId,
        role: ROLE,
      }),
      data: { stage: 'refurbishable', note: 'inspection complete' },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(pipelineId);
    expect(body.stage).toBe('refurbishable');
    expect(typeof body.updated_at).toBe('string');

    // Row updated in DB
    const rows = await db
      .select()
      .from(schema.nbfcRecoveryPipeline)
      .where(eq(schema.nbfcRecoveryPipeline.id, pipelineId));
    expect(rows.length).toBe(1);
    expect(rows[0].stage).toBe('refurbishable');
    expect(rows[0].tenant_id).toBe(ctx.tenantId);

    // Audit row inserted with before/after state
    const audits = await db
      .select()
      .from(schema.nbfcAuditLog)
      .where(
        and(
          eq(schema.nbfcAuditLog.action_id, pipelineId),
          eq(
            schema.nbfcAuditLog.action_type,
            'recovery_stage_transition',
          ),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const audit = audits[0];
    expect(audit.tenant_id).toBe(ctx.tenantId);
    expect(audit.user_id).toBe(userId);
    expect(audit.before_state).toBeTruthy();
    expect(audit.after_state).toBeTruthy();
    const before = audit.before_state as Record<string, unknown>;
    const after = audit.after_state as Record<string, unknown>;
    expect(before.stage).toBe('needs_inspection');
    expect(after.stage).toBe('refurbishable');
  });

  test('AC4: PATCH needs_inspection -> resold returns 400', async ({
    request,
  }) => {
    const pipelineId = await makePipelineRow({
      tenantId: ctx.tenantId,
      stage: 'needs_inspection',
    });
    const userId = randomUUID();

    const res = await request.patch(`/api/nbfc/recovery/${pipelineId}/stage`, {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId,
        role: ROLE,
      }),
      data: { stage: 'resold' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain('BAD_REQUEST');

    // Row stage unchanged
    const rows = await db
      .select()
      .from(schema.nbfcRecoveryPipeline)
      .where(eq(schema.nbfcRecoveryPipeline.id, pipelineId));
    expect(rows[0].stage).toBe('needs_inspection');

    // No audit row written for the rejected transition
    const audits = await db
      .select()
      .from(schema.nbfcAuditLog)
      .where(
        and(
          eq(schema.nbfcAuditLog.action_id, pipelineId),
          eq(
            schema.nbfcAuditLog.action_type,
            'recovery_stage_transition',
          ),
        ),
      );
    expect(audits.length).toBe(0);
  });
});
