/**
 * E-038 — Auction Marketplace Lots and Bidding API tests (BRD §6.1.7)
 *
 * AC1: GET /api/nbfc/auction/lots returns 200 with items array of lot objects
 *      including lot_id, capacity, avg_soh, age_months, quantity, base_price,
 *      current_bid, bidder_count, ends_at.
 * AC2: POST .../bid with confirmed=true and amount > current_bid + bid_increment
 *      returns 200 with accepted=true and persists an auction_bids row.
 * AC3: POST a bid with confirmed omitted/false returns 400.
 * AC4: POST a bid whose amount is below current_bid + bid_increment returns
 *      accepted=false with rejection_reason='below_min_next_bid' and does not
 *      insert an auction_bids row.
 * AC5: Each accepted bid writes an nbfc_audit_log row with action_type='auction_bid'
 *      and the amount captured in after_state.
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
  throw new Error('DATABASE_URL must be set for E-038 API tests');
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

const ctx: { tenantId: string } = { tenantId: '' };
const createdLotIds: string[] = [];
const createdBidIds: string[] = [];
const createdTenantIds: string[] = [];

async function getOrCreateTenant(prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({ slug, display_name: `E-038 Test NBFC ${slug}` })
    .returning();
  createdTenantIds.push(row.id);
  return row.id;
}

interface LotOpts {
  basePrice?: number;
  bidIncrement?: number;
  endsInMinutes?: number;
  status?: 'live' | 'ended';
}

async function makeLot(opts: LotOpts = {}): Promise<{
  lot_id: string;
  base_price: number;
  bid_increment: number;
}> {
  const code = `E038-${randomUUID().slice(0, 8)}`;
  const basePrice = opts.basePrice ?? 100000;
  const bidIncrement = opts.bidIncrement ?? 1000;
  const endsAt = new Date(Date.now() + (opts.endsInMinutes ?? 60) * 60_000);
  const [row] = await db
    .insert(schema.auctionLots)
    .values({
      lot_code: code,
      capacity: '48V/100Ah',
      avg_soh: '85.50',
      age_months: 18,
      quantity: 10,
      base_price: String(basePrice),
      bid_increment: String(bidIncrement),
      ends_at: endsAt,
      status: opts.status ?? 'live',
    })
    .returning();
  createdLotIds.push(row.id);
  return {
    lot_id: row.id,
    base_price: basePrice,
    bid_increment: bidIncrement,
  };
}

test.beforeAll(async () => {
  ctx.tenantId = await getOrCreateTenant('e038');
});

test.afterAll(async () => {
  // Clean up audit-log rows for our bids.
  for (const bid of createdBidIds) {
    await db
      .delete(schema.nbfcAuditLog)
      .where(eq(schema.nbfcAuditLog.action_id, bid))
      .catch(() => {});
  }
  for (const lotId of createdLotIds) {
    await db
      .delete(schema.auctionBids)
      .where(eq(schema.auctionBids.lot_id, lotId))
      .catch(() => {});
    await db
      .delete(schema.auctionLots)
      .where(eq(schema.auctionLots.id, lotId))
      .catch(() => {});
  }
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
test.describe('E-038 — Auction marketplace lots and bidding', () => {
  test('AC1: GET /api/nbfc/auction/lots returns 200 with required item fields', async ({
    request,
  }) => {
    const lot = await makeLot({ basePrice: 80000, bidIncrement: 500 });
    const userId = randomUUID();

    const res = await request.get('/api/nbfc/auction/lots?status=live', {
      headers: bypassHeaders({
        tenantId: ctx.tenantId,
        userId,
        role: NBFC_USER_ROLE,
      }),
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    const item = body.items.find(
      (i: { lot_id: string }) => i.lot_id === lot.lot_id,
    );
    expect(item).toBeTruthy();
    expect(item.lot_id).toBe(lot.lot_id);
    expect(typeof item.capacity === 'string' || item.capacity === null).toBe(
      true,
    );
    expect(typeof item.avg_soh === 'number' || item.avg_soh === null).toBe(
      true,
    );
    expect(
      typeof item.age_months === 'number' || item.age_months === null,
    ).toBe(true);
    expect(typeof item.quantity).toBe('number');
    expect(typeof item.base_price).toBe('number');
    expect(typeof item.current_bid).toBe('number');
    expect(typeof item.bidder_count).toBe('number');
    expect(typeof item.ends_at).toBe('string');
  });

  test('AC2: valid binding bid returns accepted=true and persists auction_bids row', async ({
    request,
  }) => {
    const lot = await makeLot({ basePrice: 50000, bidIncrement: 1000 });
    const userId = randomUUID();

    const res = await request.post(
      `/api/nbfc/auction/lots/${lot.lot_id}/bid`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: NBFC_USER_ROLE,
        }),
        data: {
          amount: 60000, // > 0 (current) + 1000 (increment) = 1000 minimum
          confirmed: true,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.lot_id).toBe(lot.lot_id);
    expect(body.amount).toBe(60000);
    expect(typeof body.bid_id).toBe('string');
    createdBidIds.push(body.bid_id);

    const rows = await db
      .select()
      .from(schema.auctionBids)
      .where(eq(schema.auctionBids.id, body.bid_id));
    expect(rows.length).toBe(1);
    expect(rows[0].lot_id).toBe(lot.lot_id);
    expect(rows[0].tenant_id).toBe(ctx.tenantId);
    expect(Number(rows[0].amount)).toBe(60000);
  });

  test('AC3: bid without confirmed flag returns 400', async ({ request }) => {
    const lot = await makeLot({ basePrice: 40000, bidIncrement: 500 });
    const userId = randomUUID();

    // confirmed omitted
    const r1 = await request.post(
      `/api/nbfc/auction/lots/${lot.lot_id}/bid`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: NBFC_USER_ROLE,
        }),
        data: { amount: 50000 },
      },
    );
    expect(r1.status()).toBe(400);

    // confirmed:false
    const r2 = await request.post(
      `/api/nbfc/auction/lots/${lot.lot_id}/bid`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: NBFC_USER_ROLE,
        }),
        data: { amount: 50000, confirmed: false },
      },
    );
    expect(r2.status()).toBe(400);

    // No bids should have been persisted for this lot.
    const rows = await db
      .select()
      .from(schema.auctionBids)
      .where(eq(schema.auctionBids.lot_id, lot.lot_id));
    expect(rows.length).toBe(0);
  });

  test('AC4: bid below min-next-bid returns accepted=false and persists no row', async ({
    request,
  }) => {
    const lot = await makeLot({ basePrice: 70000, bidIncrement: 5000 });
    const userId = randomUUID();

    // Place a first bid to set current_bid = 80000.
    const seedRes = await request.post(
      `/api/nbfc/auction/lots/${lot.lot_id}/bid`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: NBFC_USER_ROLE,
        }),
        data: { amount: 80000, confirmed: true },
      },
    );
    expect(seedRes.status()).toBe(200);
    const seedBody = await seedRes.json();
    expect(seedBody.accepted).toBe(true);
    createdBidIds.push(seedBody.bid_id);

    // Now bid 81000, below min-next of 85000.
    const res = await request.post(
      `/api/nbfc/auction/lots/${lot.lot_id}/bid`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: NBFC_USER_ROLE,
        }),
        data: { amount: 81000, confirmed: true },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(false);
    expect(body.rejection_reason).toBe('below_min_next_bid');

    // Only the seed bid should exist.
    const rows = await db
      .select()
      .from(schema.auctionBids)
      .where(eq(schema.auctionBids.lot_id, lot.lot_id));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(seedBody.bid_id);
  });

  test('AC5: accepted bid writes nbfc_audit_log row with action_type=auction_bid and amount in after_state', async ({
    request,
  }) => {
    const lot = await makeLot({ basePrice: 30000, bidIncrement: 250 });
    const userId = randomUUID();

    const res = await request.post(
      `/api/nbfc/auction/lots/${lot.lot_id}/bid`,
      {
        headers: bypassHeaders({
          tenantId: ctx.tenantId,
          userId,
          role: NBFC_USER_ROLE,
        }),
        data: { amount: 35000, confirmed: true },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    createdBidIds.push(body.bid_id);

    const audits = await db
      .select()
      .from(schema.nbfcAuditLog)
      .where(
        and(
          eq(schema.nbfcAuditLog.action_id, body.bid_id),
          eq(schema.nbfcAuditLog.action_type, 'auction_bid'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].tenant_id).toBe(ctx.tenantId);
    expect(audits[0].user_id).toBe(userId);
    const after = audits[0].after_state as Record<string, unknown>;
    expect(after).toBeTruthy();
    expect(after.amount).toBe(35000);
    expect(after.lot_id).toBe(lot.lot_id);
  });
});
