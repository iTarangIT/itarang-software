/**
 * E-070 — Cancel Lot dual-approval API tests (BRD §6.3.4)
 *
 * AC1: POST /cancel/request with valid MFA + non-empty reason returns 200
 *      with status='pending_second_approval'.
 * AC2: POST /cancel/request returns 400 when reason is empty.
 * AC3: POST /cancel/approve by a *different* admin with decision='approve'
 *      sets lot.status='cancelled' and the underlying inventory row's
 *      status flips back to 'in_stock' (the codebase's canonical
 *      "in inventory" value — see schema.ts inventory.status default).
 * AC4: POST /cancel/approve returns 403 when approver_id == requested_by
 *      (self-approval is forbidden).
 * AC5: On successful cancellation, an audit_logs row is written with
 *      action='AUCTION_LOT_CANCELLED', the reason, lot_id, and both
 *      requester and approver IDs.
 *
 * Auth model: this is the admin surface. We use the canonical triple-guarded
 * test bypass (NBFC_TEST_BYPASS_SECRET + x-nbfc-test-admin-id +
 * x-nbfc-test-admin-role).
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, inArray, sql as dsql } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';

// ---------------------------------------------------------------------------
// DB client
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  throw new Error('DATABASE_URL must be set for E-070 API tests');
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

// Valid MFA token (audit-export's verifier accepts the "mfa_ok" prefix).
const VALID_MFA = 'mfa_ok-e070-test';

// ---------------------------------------------------------------------------
// Fixtures + cleanup tracking
// ---------------------------------------------------------------------------
const createdRequestIds: string[] = [];
const createdLotIds: string[] = [];
const createdInventoryIds: string[] = [];
const createdAuditIds: string[] = [];
const createdLotCodes: string[] = [];

function uniqueLotCode(): string {
  return `E070-${randomUUID().slice(0, 8)}`.toUpperCase();
}

async function makeLot(): Promise<{ id: string; lot_code: string }> {
  const code = uniqueLotCode();
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
      ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // future
      status: 'live',
    })
    .returning();
  createdLotIds.push(row.id);
  createdLotCodes.push(row.lot_code);
  return { id: row.id, lot_code: row.lot_code };
}

async function makeInventoryWithSerial(serial: string): Promise<string> {
  // inventory.id is varchar — generate a unique surrogate.
  const inventoryId = `e070-inv-${randomUUID()}`;
  await db.insert(schema.inventory).values({
    id: inventoryId,
    asset_category: 'battery',
    asset_type: 'lfp',
    model_type: 'E-070 test model',
    serial_number: serial,
    status: 'in_auction', // pre-cancel state — anything other than 'in_stock'
    created_by: randomUUID(),
  });
  createdInventoryIds.push(inventoryId);
  return inventoryId;
}

test.afterAll(async () => {
  // Audit rows that name the lot ids we created.
  for (const lotId of createdLotIds) {
    await db
      .delete(schema.auditLogs)
      .where(eq(schema.auditLogs.entity_id, lotId))
      .catch(() => {});
  }
  for (const id of createdAuditIds) {
    await db
      .delete(schema.auditLogs)
      .where(eq(schema.auditLogs.id, id))
      .catch(() => {});
  }
  if (createdRequestIds.length > 0) {
    await db
      .delete(schema.nbfcAuctionCancelRequests)
      .where(inArray(schema.nbfcAuctionCancelRequests.id, createdRequestIds))
      .catch(() => {});
  }
  if (createdInventoryIds.length > 0) {
    await db
      .delete(schema.inventory)
      .where(inArray(schema.inventory.id, createdInventoryIds))
      .catch(() => {});
  }
  if (createdLotIds.length > 0) {
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
test.describe('E-070 — Auction Cancel Lot dual approval', () => {
  test('AC1: cancel request creates pending row with valid MFA and reason', async ({
    request,
  }) => {
    const lot = await makeLot();
    const requesterId = randomUUID();

    const res = await request.post(
      '/api/admin/nbfc/auction/lot/cancel/request',
      {
        headers: adminBypassHeaders(requesterId),
        data: {
          lot_id: lot.id,
          reason: 'Battery failed PDI re-inspection',
          mfa_token: VALID_MFA,
        },
      },
    );
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('pending_second_approval');
    expect(typeof body.request_id).toBe('string');
    createdRequestIds.push(body.request_id);

    // Row exists.
    const rows = await db
      .select()
      .from(schema.nbfcAuctionCancelRequests)
      .where(eq(schema.nbfcAuctionCancelRequests.id, body.request_id));
    expect(rows.length).toBe(1);
    expect(rows[0].lot_id).toBe(lot.id);
    expect(rows[0].requested_by).toBe(requesterId);
    expect(rows[0].status).toBe('pending_second_approval');
    expect(rows[0].reason).toBe('Battery failed PDI re-inspection');
  });

  test('AC2: cancel request rejects empty reason with 400', async ({
    request,
  }) => {
    const lot = await makeLot();
    const requesterId = randomUUID();

    const res = await request.post(
      '/api/admin/nbfc/auction/lot/cancel/request',
      {
        headers: adminBypassHeaders(requesterId),
        data: {
          lot_id: lot.id,
          reason: '',
          mfa_token: VALID_MFA,
        },
      },
    );
    expect(res.status()).toBe(400);

    // No row should have been written for this lot.
    const rows = await db
      .select()
      .from(schema.nbfcAuctionCancelRequests)
      .where(eq(schema.nbfcAuctionCancelRequests.lot_id, lot.id));
    expect(rows.length).toBe(0);
  });

  test('AC3: approve cancellation cancels lot and returns battery to inventory', async ({
    request,
  }) => {
    const lot = await makeLot();
    const inventoryId = await makeInventoryWithSerial(lot.lot_code);
    const requesterId = randomUUID();
    const approverId = randomUUID();

    // Step 1 — request.
    const reqRes = await request.post(
      '/api/admin/nbfc/auction/lot/cancel/request',
      {
        headers: adminBypassHeaders(requesterId),
        data: {
          lot_id: lot.id,
          reason: 'OEM recall — return to inventory',
          mfa_token: VALID_MFA,
        },
      },
    );
    expect(reqRes.status()).toBe(200);
    const reqBody = await reqRes.json();
    createdRequestIds.push(reqBody.request_id);

    // Step 2 — approve by a different admin.
    const apRes = await request.post(
      '/api/admin/nbfc/auction/lot/cancel/approve',
      {
        headers: adminBypassHeaders(approverId),
        data: {
          request_id: reqBody.request_id,
          decision: 'approve',
        },
      },
    );
    expect(apRes.status(), await apRes.text().catch(() => '')).toBe(200);
    const apBody = await apRes.json();
    expect(apBody.status).toBe('executed');
    expect(apBody.battery_returned_to_inventory).toBe(true);

    // Lot is cancelled.
    const lotRows = await db
      .select()
      .from(schema.auctionLots)
      .where(eq(schema.auctionLots.id, lot.id));
    expect(lotRows[0].status).toBe('cancelled');

    // Inventory row flipped back to 'in_stock' (the codebase's canonical
    // "in inventory" value — see schema.ts inventory.status default).
    const invRows = await db
      .select()
      .from(schema.inventory)
      .where(eq(schema.inventory.id, inventoryId));
    expect(invRows[0].status).toBe('in_stock');
  });

  test('AC4: cancel approve rejects self-approval with 403', async ({
    request,
  }) => {
    const lot = await makeLot();
    const sameAdminId = randomUUID();

    const reqRes = await request.post(
      '/api/admin/nbfc/auction/lot/cancel/request',
      {
        headers: adminBypassHeaders(sameAdminId),
        data: {
          lot_id: lot.id,
          reason: 'Same-admin self-approval test',
          mfa_token: VALID_MFA,
        },
      },
    );
    expect(reqRes.status()).toBe(200);
    const reqBody = await reqRes.json();
    createdRequestIds.push(reqBody.request_id);

    const apRes = await request.post(
      '/api/admin/nbfc/auction/lot/cancel/approve',
      {
        headers: adminBypassHeaders(sameAdminId),
        data: {
          request_id: reqBody.request_id,
          decision: 'approve',
        },
      },
    );
    expect(apRes.status()).toBe(403);

    // Lot stays live; request stays pending.
    const lotRows = await db
      .select()
      .from(schema.auctionLots)
      .where(eq(schema.auctionLots.id, lot.id));
    expect(lotRows[0].status).toBe('live');

    const reqRows = await db
      .select()
      .from(schema.nbfcAuctionCancelRequests)
      .where(eq(schema.nbfcAuctionCancelRequests.id, reqBody.request_id));
    expect(reqRows[0].status).toBe('pending_second_approval');
  });

  test('AC5: audit log row written with reason and approver IDs on cancellation', async ({
    request,
  }) => {
    const lot = await makeLot();
    const requesterId = randomUUID();
    const approverId = randomUUID();
    const reasonText = `E-070 audit-test reason ${randomUUID().slice(0, 8)}`;

    const reqRes = await request.post(
      '/api/admin/nbfc/auction/lot/cancel/request',
      {
        headers: adminBypassHeaders(requesterId),
        data: {
          lot_id: lot.id,
          reason: reasonText,
          mfa_token: VALID_MFA,
        },
      },
    );
    expect(reqRes.status()).toBe(200);
    const reqBody = await reqRes.json();
    createdRequestIds.push(reqBody.request_id);

    const apRes = await request.post(
      '/api/admin/nbfc/auction/lot/cancel/approve',
      {
        headers: adminBypassHeaders(approverId),
        data: {
          request_id: reqBody.request_id,
          decision: 'approve',
        },
      },
    );
    expect(apRes.status()).toBe(200);

    // The service writes one audit_logs row with action='AUCTION_LOT_CANCELLED',
    // entity_id=lot.id. We assert all the BRD-mandated fields on it.
    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(
        dsql`${schema.auditLogs.entity_id} = ${lot.id} AND ${schema.auditLogs.action} = 'AUCTION_LOT_CANCELLED'`,
      );
    expect(auditRows.length).toBe(1);
    const a = auditRows[0];
    expect(a.performed_by).toBe(approverId);
    const newData = a.new_data as Record<string, unknown> | null;
    expect(newData).toBeTruthy();
    expect(newData?.reason).toBe(reasonText);
    expect(newData?.lot_id).toBe(lot.id);
    expect(newData?.requested_by).toBe(requesterId);
    expect(newData?.approved_by).toBe(approverId);
  });
});
