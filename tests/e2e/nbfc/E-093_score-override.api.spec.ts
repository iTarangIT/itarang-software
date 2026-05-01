/**
 * E-093 — Score Override with documented reason — API tests.
 *
 * AC1: nbfc_risk_manager + reason ≥ 20 → 200 with is_active=true (and the
 *      computed score table, if present, is unchanged).
 * AC2: caller without role 'nbfc_risk_manager' → 403.
 * AC3: reason < 20 chars → 400.
 * AC4: second override for the same (loan_application_id, score_type) flips
 *      the prior row's is_active=false; both writes appear in audit_logs as
 *      action='score.override.created'.
 * AC5: GET /override returns active_override populated and history newest-first.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, desc } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-093 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e093-loop-bypass-secret';

function bypassHeaders(opts: { tenantId: string; userId: string; role: string }) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-tenant-id': opts.tenantId,
    'x-nbfc-test-user-id': opts.userId,
    'x-nbfc-test-user-role': opts.role,
  };
}

const RISK_MANAGER_ROLE = 'nbfc_risk_manager';
const ctx: { tenantId: string } = { tenantId: '' };
const createdOverrideIds = new Set<string>();
const createdLoanIds = new Set<string>();

async function getOrCreateTenant(): Promise<string> {
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.is_active, true))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const slug = `e093-${Date.now()}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-093 Test NBFC ${slug}` })
    .returning();
  return row.id;
}

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant();
});

test.afterAll(async () => {
  for (const id of createdOverrideIds) {
    await db
      .delete(schema.nbfcScoreOverrides)
      .where(eq(schema.nbfcScoreOverrides.id, id));
    await db
      .delete(schema.auditLogs)
      .where(eq(schema.auditLogs.entity_id, id));
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

const VALID_REASON =
  'Manual recalculation per branch credit committee deliberations';

test.describe('E-093 — Score Override', () => {
  test('AC1: Risk Manager + valid reason creates active override', async ({
    request,
  }) => {
    const userId = randomUUID();
    const loanId = `L-AC1-${randomUUID().slice(0, 8)}`;
    createdLoanIds.add(loanId);

    const res = await request.post('/api/nbfc/scores/override', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId,
        role: RISK_MANAGER_ROLE,
      }),
      data: {
        loan_application_id: loanId,
        score_type: 'cds',
        override_value: 72.5,
        reason: VALID_REASON,
        computed_score_value: 60.0,
      },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.is_active).toBe(true);
    expect(Number(body.override_value)).toBeCloseTo(72.5);
    expect(Number(body.computed_score_value)).toBeCloseTo(60.0);
    expect(body.created_by).toBe(userId);
    createdOverrideIds.add(body.id);

    // Audit log row exists with the canonical action name.
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.entity_id, body.id),
          eq(schema.auditLogs.action, 'score.override.created'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].performed_by).toBe(userId);

    // Sanity: row in nbfc_score_overrides table.
    const rows = await db
      .select()
      .from(schema.nbfcScoreOverrides)
      .where(eq(schema.nbfcScoreOverrides.id, body.id));
    expect(rows.length).toBe(1);
    expect(rows[0].is_active).toBe(true);
  });

  test('AC2: Non-Risk-Manager role gets 403', async ({ request }) => {
    const res = await request.post('/api/nbfc/scores/override', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: 'viewer',
      }),
      data: {
        loan_application_id: `L-AC2-${randomUUID().slice(0, 8)}`,
        score_type: 'cds',
        override_value: 80,
        reason: VALID_REASON,
        computed_score_value: 60,
      },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(String(body.error)).toContain('FORBIDDEN');
  });

  test('AC3: Reason < 20 chars returns 400', async ({ request }) => {
    const res = await request.post('/api/nbfc/scores/override', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId: randomUUID(),
        role: RISK_MANAGER_ROLE,
      }),
      data: {
        loan_application_id: `L-AC3-${randomUUID().slice(0, 8)}`,
        score_type: 'cds',
        override_value: 70,
        reason: 'too short',
        computed_score_value: 60,
      },
    });
    expect(res.status()).toBe(400);
  });

  test('AC4: Second override supersedes prior; both audit-logged', async ({
    request,
  }) => {
    const userId = randomUUID();
    const loanId = `L-AC4-${randomUUID().slice(0, 8)}`;
    createdLoanIds.add(loanId);

    const first = await request.post('/api/nbfc/scores/override', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId,
        role: RISK_MANAGER_ROLE,
      }),
      data: {
        loan_application_id: loanId,
        score_type: 'pci',
        override_value: 65,
        reason: VALID_REASON + ' (first)',
        computed_score_value: 50,
      },
    });
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    createdOverrideIds.add(firstBody.id);

    const second = await request.post('/api/nbfc/scores/override', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId,
        role: RISK_MANAGER_ROLE,
      }),
      data: {
        loan_application_id: loanId,
        score_type: 'pci',
        override_value: 78,
        reason: VALID_REASON + ' (second, supersedes prior)',
        computed_score_value: 50,
      },
    });
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    createdOverrideIds.add(secondBody.id);
    expect(secondBody.is_active).toBe(true);

    // First row should now be is_active=false.
    const firstRow = await db
      .select()
      .from(schema.nbfcScoreOverrides)
      .where(eq(schema.nbfcScoreOverrides.id, firstBody.id))
      .limit(1);
    expect(firstRow[0].is_active).toBe(false);

    // Both writes are audit-logged with action='score.override.created'.
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, 'score.override.created'));
    const ourAuditIds = audits
      .map((a) => a.entity_id)
      .filter((eid): eid is string => eid === firstBody.id || eid === secondBody.id);
    expect(ourAuditIds).toContain(firstBody.id);
    expect(ourAuditIds).toContain(secondBody.id);
  });

  test('AC5: GET returns active_override and history newest-first', async ({
    request,
  }) => {
    const userId = randomUUID();
    const loanId = `L-AC5-${randomUUID().slice(0, 8)}`;
    createdLoanIds.add(loanId);

    // Create three overrides; only the last should be active.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request.post('/api/nbfc/scores/override', {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: RISK_MANAGER_ROLE,
        }),
        data: {
          loan_application_id: loanId,
          score_type: 'cds',
          override_value: 60 + i * 5,
          reason: VALID_REASON + ` round ${i}`,
          computed_score_value: 55,
        },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      ids.push(body.id);
      createdOverrideIds.add(body.id);
      // Tiny gap so created_at orders deterministically.
      await new Promise((r) => setTimeout(r, 25));
    }

    const get = await request.get(
      `/api/nbfc/scores/override?loan_application_id=${encodeURIComponent(loanId)}&score_type=cds`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: RISK_MANAGER_ROLE,
        }),
      },
    );
    expect(get.status(), await get.text().catch(() => '')).toBe(200);
    const body = await get.json();
    expect(body.active_override).toBeTruthy();
    expect(body.active_override.id).toBe(ids[ids.length - 1]);
    expect(body.history.length).toBeGreaterThanOrEqual(3);
    // Newest first.
    const ts = body.history.map((r: { created_at: string }) =>
      new Date(r.created_at).getTime(),
    );
    for (let i = 0; i + 1 < ts.length; i++) {
      expect(ts[i]).toBeGreaterThanOrEqual(ts[i + 1]);
    }
  });
});

void desc;
