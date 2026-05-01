/**
 * E-069 — Auction Control Centre admin actions API tests (BRD §6.3.4)
 *
 * AC1: extend-time pushes ends_at by selected minutes (30 → +30m).
 * AC2: reduce-time returns 400 when mfa_token is missing or shorter than 6 chars.
 * AC3: pause sets lot.status='paused' and returns notified_bidders > 0 when
 *      at least one bidder exists.
 * AC4: reserve-price returns 409 when at least one bid already exists on the lot.
 * AC5: approve-winning-bid returns 200 with payment_collection_started=true
 *      when the lot is closed and the bid is the highest valid bid.
 * AC6: All five endpoints return 403 when called by a non-admin caller.
 *
 * Auth model: triple-guarded test bypass (NBFC_TEST_BYPASS_SECRET +
 * x-nbfc-test-admin-id + x-nbfc-test-admin-role) — same as E-070.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-069 API tests');
}
const sql = postgres(DB_URL, { ssl: 'require', prepare: false });
const db = drizzle(sql, { schema });

// ---------------------------------------------------------------------------
// Bypass plumbing
// ---------------------------------------------------------------------------
const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

function adminBypassHeaders(adminId: string) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-admin-id': adminId,
    'x-nbfc-test-admin-role': 'admin',
  };
}

function nonAdminBypassHeaders(userId: string) {
  return {
    'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
    'x-nbfc-test-admin-id': userId,
    'x-nbfc-test-admin-role': 'dealer',
  };
}

const VALID_MFA = 'mfa_ok-e069-test';

// ---------------------------------------------------------------------------
// Fixtures + cleanup tracking
// ---------------------------------------------------------------------------
const createdLotIds: string[] = [];
const createdBidIds: string[] = [];
const createdSettlementLotIds: string[] = [];

function uniqueLotCode(): string {
  return `E069-${randomUUID().slice(0, 8)}`.toUpperCase();
}

async function makeLot(opts: {
  endsInMinutes?: number;
  status?: string;
  base_price?: number;
} = {}): Promise<{ id: string; lot_code: string; ends_at: Date; base_price: string }> {
  const code = uniqueLotCode();
  const endsInMinutes = opts.endsInMinutes ?? 60;
  const ends_at = new Date(Date.now() + endsInMinutes * 60 * 1000);
  const [row] = await db
    .insert(schema.auctionLots)
    .values({
      lot_code: code,
      capacity: '48V/100Ah',
      avg_soh: '85.00',
      age_months: 18,
      quantity: 1,
      base_price: String(opts.base_price ?? 50000),
      bid_increment: '500',
      ends_at,
      status: opts.status ?? 'live',
    })
    .returning();
  createdLotIds.push(row.id);
  return {
    id: row.id,
    lot_code: row.lot_code,
    ends_at: new Date(row.ends_at),
    base_price: row.base_price,
  };
}

async function makeBid(
  lot_id: string,
  amount: number,
  tenant_id?: string,
): Promise<{ id: string; tenant_id: string }> {
  const tid = tenant_id ?? randomUUID();
  const [row] = await db
    .insert(schema.auctionBids)
    .values({
      lot_id,
      tenant_id: tid,
      amount: String(amount),
    })
    .returning();
  createdBidIds.push(row.id);
  return { id: row.id, tenant_id: tid };
}

test.afterAll(async () => {
  // nbfc_auction_lot_actions rows pointing at our lots
  for (const lotId of createdLotIds) {
    await db
      .delete(schema.nbfcAuctionLotActions)
      .where(eq(schema.nbfcAuctionLotActions.lot_id, lotId))
      .catch(() => {});
  }
  for (const lotId of createdSettlementLotIds) {
    await db
      .delete(schema.auctionSettlements)
      .where(eq(schema.auctionSettlements.lot_id, lotId))
      .catch(() => {});
  }
  if (createdBidIds.length > 0) {
    await db
      .delete(schema.auctionBids)
      .where(inArray(schema.auctionBids.id, createdBidIds))
      .catch(() => {});
  }
  if (createdLotIds.length > 0) {
    // Settlement rows can also exist when approve-winning-bid was exercised
    // without our explicit tracking — clean those too.
    await db
      .delete(schema.auctionSettlements)
      .where(inArray(schema.auctionSettlements.lot_id, createdLotIds))
      .catch(() => {});
    await db
      .delete(schema.auctionLots)
      .where(inArray(schema.auctionLots.id, createdLotIds))
      .catch(() => {});
  }
  await sql.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC tests
// ---------------------------------------------------------------------------
test.describe('E-069 — Auction Control Centre admin actions', () => {
  test('AC1: extend-time pushes closing_at by selected minutes', async ({
    request,
  }) => {
    const lot = await makeLot({ endsInMinutes: 60 });
    const adminId = randomUUID();

    const before = lot.ends_at.getTime();

    const res = await request.post(
      '/api/admin/nbfc/auction/lot/extend-time',
      {
        headers: adminBypassHeaders(adminId),
        data: {
          lot_id: lot.id,
          extend_by_minutes: 30,
          reason: 'Last-minute bidder reported network issues',
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.lot_id).toBe(lot.id);
    expect(typeof body.new_closing_at).toBe('string');

    const newClose = new Date(body.new_closing_at).getTime();
    // Allow ±2s clock drift; we want exactly +30m.
    expect(newClose - before).toBeGreaterThanOrEqual(30 * 60 * 1000 - 2_000);
    expect(newClose - before).toBeLessThanOrEqual(30 * 60 * 1000 + 2_000);

    // Verify in-DB.
    const [lotRow] = await db
      .select({ ends_at: schema.auctionLots.ends_at })
      .from(schema.auctionLots)
      .where(eq(schema.auctionLots.id, lot.id));
    expect(new Date(lotRow.ends_at).getTime()).toBe(newClose);

    // Audit row written.
    const actionRows = await db
      .select()
      .from(schema.nbfcAuctionLotActions)
      .where(eq(schema.nbfcAuctionLotActions.lot_id, lot.id));
    expect(actionRows.length).toBe(1);
    expect(actionRows[0].action_code).toBe('extend_time');
    expect(actionRows[0].acted_by).toBe(adminId);
    expect(actionRows[0].reason).toBe(
      'Last-minute bidder reported network issues',
    );
  });

  test('AC2: reduce-time rejects request without valid MFA (400)', async ({
    request,
  }) => {
    const lot = await makeLot();

    // Missing mfa_token entirely → zod rejects → 400.
    const r1 = await request.post(
      '/api/admin/nbfc/auction/lot/reduce-time',
      {
        headers: adminBypassHeaders(randomUUID()),
        data: {
          lot_id: lot.id,
          reduce_by_minutes: 15,
          end_now: false,
        },
      },
    );
    expect(r1.status()).toBe(400);

    // Too-short mfa_token → zod min(6) rejects → 400.
    const r2 = await request.post(
      '/api/admin/nbfc/auction/lot/reduce-time',
      {
        headers: adminBypassHeaders(randomUUID()),
        data: {
          lot_id: lot.id,
          reduce_by_minutes: 15,
          end_now: false,
          mfa_token: 'abc',
        },
      },
    );
    expect(r2.status()).toBe(400);

    // Lot ends_at unchanged.
    const [lotRow] = await db
      .select({ ends_at: schema.auctionLots.ends_at })
      .from(schema.auctionLots)
      .where(eq(schema.auctionLots.id, lot.id));
    expect(new Date(lotRow.ends_at).getTime()).toBe(lot.ends_at.getTime());
  });

  test('AC3: pause sets status=paused and returns notified_bidders > 0', async ({
    request,
  }) => {
    const lot = await makeLot();
    // Two bidders so the count is testable as > 0.
    await makeBid(lot.id, 51000);
    await makeBid(lot.id, 52000);

    const res = await request.post(
      '/api/admin/nbfc/auction/lot/pause',
      {
        headers: adminBypassHeaders(randomUUID()),
        data: {
          lot_id: lot.id,
          reason: 'Investigating bid anomaly on this lot',
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.lot_id).toBe(lot.id);
    expect(body.status).toBe('paused');
    expect(typeof body.notified_bidders).toBe('number');
    expect(body.notified_bidders).toBeGreaterThan(0);

    // Lot row reflects paused state.
    const [lotRow] = await db
      .select({ status: schema.auctionLots.status })
      .from(schema.auctionLots)
      .where(eq(schema.auctionLots.id, lot.id));
    expect(lotRow.status).toBe('paused');
  });

  test('AC4: reserve-price rejects post-bid change with 409', async ({
    request,
  }) => {
    const lot = await makeLot({ base_price: 50000 });
    // Place a bid first → reserve-price change should be forbidden.
    await makeBid(lot.id, 50500);

    const res = await request.post(
      '/api/admin/nbfc/auction/lot/reserve-price',
      {
        headers: adminBypassHeaders(randomUUID()),
        data: {
          lot_id: lot.id,
          reserve_price_inr: 60000,
        },
      },
    );
    expect(res.status()).toBe(409);

    // base_price unchanged.
    const [lotRow] = await db
      .select({ base_price: schema.auctionLots.base_price })
      .from(schema.auctionLots)
      .where(eq(schema.auctionLots.id, lot.id));
    expect(Number(lotRow.base_price)).toBe(50000);
  });

  test('AC5: approve-winning-bid triggers payment collection', async ({
    request,
  }) => {
    // Lot already ended (1 minute in the past) — approve-winning-bid is the
    // post-auction confirmation step.
    const lot = await makeLot({ endsInMinutes: -1, status: 'ended' });
    const losing = await makeBid(lot.id, 51000);
    const winning = await makeBid(lot.id, 52500);
    void losing;

    const res = await request.post(
      '/api/admin/nbfc/auction/lot/approve-winning-bid',
      {
        headers: adminBypassHeaders(randomUUID()),
        data: {
          lot_id: lot.id,
          winning_bid_id: winning.id,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.lot_id).toBe(lot.id);
    expect(body.winning_bid_id).toBe(winning.id);
    expect(body.payment_collection_started).toBe(true);

    createdSettlementLotIds.push(lot.id);

    // Settlement row landed in payment_pending.
    const settlements = await db
      .select()
      .from(schema.auctionSettlements)
      .where(eq(schema.auctionSettlements.lot_id, lot.id));
    expect(settlements.length).toBe(1);
    expect(settlements[0].status).toBe('payment_pending');
    expect(settlements[0].winner_tenant_id).toBe(winning.tenant_id);
  });

  test('AC6: all five endpoints return 403 for non-admin caller', async ({
    request,
  }) => {
    const lot = await makeLot();
    const winning = await makeBid(lot.id, 51000);
    const headers = nonAdminBypassHeaders(randomUUID());

    const probes: Array<{ path: string; data: Record<string, unknown> }> = [
      {
        path: '/api/admin/nbfc/auction/lot/extend-time',
        data: { lot_id: lot.id, extend_by_minutes: 15, reason: 'test' },
      },
      {
        path: '/api/admin/nbfc/auction/lot/reduce-time',
        data: {
          lot_id: lot.id,
          reduce_by_minutes: 15,
          end_now: false,
          mfa_token: VALID_MFA,
        },
      },
      {
        path: '/api/admin/nbfc/auction/lot/pause',
        data: { lot_id: lot.id, reason: 'test' },
      },
      {
        path: '/api/admin/nbfc/auction/lot/reserve-price',
        data: { lot_id: lot.id, reserve_price_inr: 70000 },
      },
      {
        path: '/api/admin/nbfc/auction/lot/approve-winning-bid',
        data: { lot_id: lot.id, winning_bid_id: winning.id },
      },
    ];

    for (const p of probes) {
      const r = await request.post(p.path, { headers, data: p.data });
      expect(r.status(), `${p.path} should reject non-admin with 403`).toBe(
        403,
      );
    }
  });
});
