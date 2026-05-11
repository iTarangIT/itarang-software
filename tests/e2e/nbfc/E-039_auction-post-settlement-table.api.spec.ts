/**
 * E-039 — Post-auction settlement table API tests (BRD §6.1.7)
 *
 * AC1: GET /api/nbfc/auction/settlements returns 200 with items containing
 *      lot_id, final_price, winner_tenant_id, winner_name, status, updated_at.
 * AC2: PATCH .../[id] with status='in_transit' on a row currently in
 *      'payment_pending' updates the row and returns 200.
 * AC3: PATCH attempting to move from 'payment_pending' directly to 'delivered'
 *      returns 400.
 * AC4: When a settlement reaches status='delivered' the linked
 *      nbfc_recovery_pipeline row's stage becomes 'resold'.
 *
 * Auth uses the canonical triple-guarded test bypass.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-039 API tests');
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
const NBFC_USER_ROLE = 'nbfc_credit_manager';

const ctx: { sellerTenantId: string; winnerTenantId: string } = {
  sellerTenantId: '',
  winnerTenantId: '',
};
const createdSettlementIds: string[] = [];
const createdLotIds: string[] = [];
const createdTenantIds: string[] = [];
const createdRecoveryIds: string[] = [];
const createdAuditIds: string[] = [];

async function makeTenant(prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-039 ${prefix} ${slug}` })
    .returning();
  createdTenantIds.push(row.id);
  return row.id;
}

async function makeLot(): Promise<{ id: string; lot_code: string }> {
  const code = `E039-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(schema.auctionLots)
    .values({
      lot_code: code,
      capacity: '48V/100Ah',
      avg_soh: '85.00',
      age_months: 18,
      quantity: 1,
      base_price: '50000',
      bid_increment: '500',
      ends_at: new Date(Date.now() - 60_000), // already ended
      status: 'ended',
    })
    .returning();
  createdLotIds.push(row.id);
  return { id: row.id, lot_code: row.lot_code };
}

async function makeSettlement(opts: {
  lotId: string;
  finalPrice: number;
  status?: 'payment_pending' | 'in_transit' | 'delivered';
}): Promise<string> {
  const [row] = await db
    .insert(schema.auctionSettlements)
    .values({
      lot_id: opts.lotId,
      seller_tenant_id: ctx.sellerTenantId,
      winner_tenant_id: ctx.winnerTenantId,
      final_price: String(opts.finalPrice),
      status: opts.status ?? 'payment_pending',
    })
    .returning();
  createdSettlementIds.push(row.id);
  return row.id;
}

test.beforeAll(async () => {
  ctx.sellerTenantId = await makeTenant('seller');
  ctx.winnerTenantId = await makeTenant('winner');
});

test.afterAll(async () => {
  for (const id of createdAuditIds) {
    await db
      .delete(schema.nbfcAuditLog)
      .where(eq(schema.nbfcAuditLog.action_id, id))
      .catch(() => {});
  }
  for (const id of createdSettlementIds) {
    // Audit rows are keyed by settlement id
    await db
      .delete(schema.nbfcAuditLog)
      .where(eq(schema.nbfcAuditLog.action_id, id))
      .catch(() => {});
    await db
      .delete(schema.auctionSettlements)
      .where(eq(schema.auctionSettlements.id, id))
      .catch(() => {});
  }
  for (const id of createdRecoveryIds) {
    await db
      .delete(schema.nbfcRecoveryPipeline)
      .where(eq(schema.nbfcRecoveryPipeline.id, id))
      .catch(() => {});
  }
  for (const id of createdLotIds) {
    await db
      .delete(schema.auctionLots)
      .where(eq(schema.auctionLots.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db
      .delete(schema.nbfcTenants)
      .where(eq(schema.nbfcTenants.id, id))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe('E-039 — Post-auction settlement table', () => {
  test('AC1: GET /api/nbfc/auction/settlements returns BRD columns', async ({
    request,
  }) => {
    const lot = await makeLot();
    const settlementId = await makeSettlement({
      lotId: lot.id,
      finalPrice: 67500,
      status: 'payment_pending',
    });
    const userId = randomUUID();

    const res = await request.get('/api/nbfc/auction/settlements', {
      headers: bypassHeaders({
        tenantId: ctx.sellerTenantId,
        userId,
        role: NBFC_USER_ROLE,
      }),
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    const item = body.items.find(
      (i: { id: string }) => i.id === settlementId,
    );
    expect(item, 'settlement present in list').toBeTruthy();
    expect(typeof item.lot_id).toBe('string');
    expect(item.lot_id).toBe(lot.id);
    expect(typeof item.final_price).toBe('number');
    expect(item.final_price).toBe(67500);
    expect(typeof item.winner_tenant_id).toBe('string');
    expect(item.winner_tenant_id).toBe(ctx.winnerTenantId);
    expect(typeof item.winner_name).toBe('string');
    expect(item.winner_name.length).toBeGreaterThan(0);
    expect(item.status).toBe('payment_pending');
    expect(typeof item.updated_at).toBe('string');
  });

  test('AC2: allowed status transition updates settlement', async ({
    request,
  }) => {
    const lot = await makeLot();
    const id = await makeSettlement({
      lotId: lot.id,
      finalPrice: 80000,
      status: 'payment_pending',
    });
    const userId = randomUUID();

    const res = await request.patch(`/api/nbfc/auction/settlements/${id}`, {
      headers: bypassHeaders({
        tenantId: ctx.sellerTenantId,
        userId,
        role: NBFC_USER_ROLE,
      }),
      data: { status: 'in_transit' },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.status).toBe('in_transit');
    expect(typeof body.updated_at).toBe('string');

    // Verify DB row matches.
    const rows = await db
      .select()
      .from(schema.auctionSettlements)
      .where(eq(schema.auctionSettlements.id, id));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('in_transit');
  });

  test('AC3: invalid settlement transition is rejected with 400', async ({
    request,
  }) => {
    const lot = await makeLot();
    const id = await makeSettlement({
      lotId: lot.id,
      finalPrice: 55000,
      status: 'payment_pending',
    });
    const userId = randomUUID();

    const res = await request.patch(`/api/nbfc/auction/settlements/${id}`, {
      headers: bypassHeaders({
        tenantId: ctx.sellerTenantId,
        userId,
        role: NBFC_USER_ROLE,
      }),
      data: { status: 'delivered' },
    });
    expect(res.status()).toBe(400);

    // Row stays in payment_pending.
    const rows = await db
      .select()
      .from(schema.auctionSettlements)
      .where(eq(schema.auctionSettlements.id, id));
    expect(rows[0].status).toBe('payment_pending');
  });

  test('AC4: delivered settlement marks recovery pipeline as resold', async ({
    request,
  }) => {
    const lot = await makeLot();
    const id = await makeSettlement({
      lotId: lot.id,
      finalPrice: 90000,
      status: 'in_transit', // already advanced so we can move to delivered
    });

    // Seed a recovery_pipeline row whose battery_serial == lot.lot_code,
    // owned by the seller tenant. The settlement's transition to delivered
    // should flip its stage to 'resold'.
    const [recovery] = await db
      .insert(schema.nbfcRecoveryPipeline)
      .values({
        tenant_id: ctx.sellerTenantId,
        battery_serial: lot.lot_code,
        stage: 'awaiting_auction',
        estimated_recovery_value: '90000',
      })
      .returning();
    createdRecoveryIds.push(recovery.id);

    const userId = randomUUID();
    const res = await request.patch(`/api/nbfc/auction/settlements/${id}`, {
      headers: bypassHeaders({
        tenantId: ctx.sellerTenantId,
        userId,
        role: NBFC_USER_ROLE,
      }),
      data: { status: 'delivered' },
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('delivered');

    const recoveryRows = await db
      .select()
      .from(schema.nbfcRecoveryPipeline)
      .where(eq(schema.nbfcRecoveryPipeline.id, recovery.id));
    expect(recoveryRows.length).toBe(1);
    expect(recoveryRows[0].stage).toBe('resold');
  });
});
