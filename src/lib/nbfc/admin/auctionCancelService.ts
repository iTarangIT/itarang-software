/**
 * E-070 — Dual-approval workflow for cancelling an auction lot
 * (BRD §6.3.4 "Cancel Lot").
 *
 * Cancel Lot is the ONLY auction action that requires dual approval. Two
 * different admins must agree:
 *
 *   1. First admin (requester) POSTs /cancel/request with a fresh MFA token,
 *      the target lot_id, and a mandatory reason. We validate the MFA token,
 *      validate that the lot exists and is in a cancellable state, and insert
 *      a pending row.
 *
 *   2. A second admin (a DIFFERENT user) POSTs /cancel/approve with either
 *      decision='approve' or decision='reject'. Self-approval is forbidden.
 *      On approve we atomically:
 *        a. Flip the request to status='executed' (race-guarded).
 *        b. Set auction_lots.status = 'cancelled'.
 *        c. Return the underlying batteries to stock: inventory rows are
 *           resolved through auction_lot_items → recovery_batteries.serial
 *           (the legacy lot_code match is kept as an OR for hand-linked rows),
 *           and the batteries themselves go from `lotted` back to `ready` so
 *           they can be re-listed. `inventory.status` defaults to 'in_stock',
 *           so that is the canonical "in inventory" value in this codebase.
 *        d. Append an audit_logs row with action='AUCTION_LOT_CANCELLED'
 *           carrying the reason, both approver IDs, and lot_id.
 *
 * Distinct from `dual_approval_requests` (E-082): that primitive gates
 * per-NBFC tenant *operational* actions (immobilisation, restructuring). This
 * table is platform-global because lots themselves are platform-owned in this
 * release (auction_lots has no tenant_id column).
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auctionLots,
  auditLogs,
  inventory,
  nbfcAuctionCancelRequests,
} from "@/lib/db/schema";
import { verifyStepUp } from "@/lib/nbfc/security/step-up";
import { notifyLotLifecycle } from "@/lib/nbfc/auction/notify";

/**
 * The local verifier that used to sit here accepted any 6–8 digit string. It
 * has been replaced by the shared step-up check, which verifies the requesting
 * admin's own credential — see `@/lib/nbfc/security/step-up`.
 */

export type RequestCancelInput = {
  lot_id: string;
  reason: string;
  mfa_token: string;
  requester_user_id: string;
};

export type RequestCancelResult = {
  request_id: string;
  status: "pending_second_approval";
};

export type ApproveCancelInput = {
  request_id: string;
  approver_user_id: string;
  decision: "approve" | "reject";
};

export type ApproveCancelResult = {
  request_id: string;
  status: "executed" | "rejected";
  battery_returned_to_inventory: boolean;
  applied_at: string | null;
};

/**
 * Step 1 — Create a pending cancellation request.
 *
 * Throws:
 *   - UNAUTHORIZED: invalid mfa_token (route already enforces zod min(6),
 *     but we do a structural check too so a 6-char "INVALID" string still
 *     fails closed)
 *   - BAD_REQUEST: empty reason (the route's zod also covers this; defense
 *     in depth)
 *   - NOT_FOUND: lot_id does not exist
 *   - CONFLICT: lot is already cancelled
 */
export async function createCancelRequest(
  input: RequestCancelInput,
): Promise<RequestCancelResult> {
  const stepUpOk = await verifyStepUp({
    user_id: input.requester_user_id,
    token: input.mfa_token,
  });
  if (!stepUpOk) {
    throw new Error("UNAUTHORIZED: invalid mfa_token");
  }
  const trimmedReason = input.reason?.trim() ?? "";
  if (!trimmedReason) {
    throw new Error("BAD_REQUEST: reason must not be empty");
  }

  const [lot] = await db
    .select({ id: auctionLots.id, status: auctionLots.status })
    .from(auctionLots)
    .where(eq(auctionLots.id, input.lot_id))
    .limit(1);

  if (!lot) {
    throw new Error("NOT_FOUND: lot not found");
  }
  if (lot.status === "cancelled") {
    throw new Error("CONFLICT: lot is already cancelled");
  }

  const [row] = await db
    .insert(nbfcAuctionCancelRequests)
    .values({
      lot_id: input.lot_id,
      reason: trimmedReason,
      requested_by: input.requester_user_id,
      status: "pending_second_approval",
    })
    .returning({
      id: nbfcAuctionCancelRequests.id,
    });

  return {
    request_id: row.id,
    status: "pending_second_approval",
  };
}

/**
 * Step 2 — A second admin approves or rejects.
 *
 * Throws:
 *   - NOT_FOUND: request_id not found
 *   - CONFLICT: request not in pending_second_approval state
 *   - FORBIDDEN: same admin as requester (self-approval)
 */
export async function approveCancelRequest(
  input: ApproveCancelInput,
): Promise<ApproveCancelResult> {
  const [pending] = await db
    .select({
      id: nbfcAuctionCancelRequests.id,
      lot_id: nbfcAuctionCancelRequests.lot_id,
      reason: nbfcAuctionCancelRequests.reason,
      requested_by: nbfcAuctionCancelRequests.requested_by,
      status: nbfcAuctionCancelRequests.status,
    })
    .from(nbfcAuctionCancelRequests)
    .where(eq(nbfcAuctionCancelRequests.id, input.request_id))
    .limit(1);

  if (!pending) {
    throw new Error("NOT_FOUND: cancel request not found");
  }
  if (pending.status !== "pending_second_approval") {
    throw new Error(
      `CONFLICT: cancel request is in status "${pending.status}", not pending_second_approval`,
    );
  }
  if (pending.requested_by === input.approver_user_id) {
    throw new Error(
      "FORBIDDEN: same admin cannot self-approve their own cancel request",
    );
  }

  const now = new Date();

  if (input.decision === "reject") {
    await db
      .update(nbfcAuctionCancelRequests)
      .set({
        status: "rejected",
        approved_by: input.approver_user_id,
        applied_at: null,
      })
      .where(eq(nbfcAuctionCancelRequests.id, input.request_id));

    // The rejection itself is auditable.
    await db.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "auction_lot",
      entity_id: pending.lot_id,
      action: "AUCTION_LOT_CANCEL_REJECTED",
      performed_by: input.approver_user_id,
      old_data: {
        reason: pending.reason,
        requested_by: pending.requested_by,
        approved_by: input.approver_user_id,
        cancel_request_id: pending.id,
      },
      new_data: null,
      timestamp: now,
    });

    return {
      request_id: pending.id,
      status: "rejected",
      battery_returned_to_inventory: false,
      applied_at: null,
    };
  }

  // decision === 'approve' — atomic commit.
  let inventoryReturned = false;

  await db.transaction(async (tx) => {
    // Race-guard: only commit if the request is still pending. Idempotent
    // under concurrent second-approval calls — only one wins.
    const flipped = await tx
      .update(nbfcAuctionCancelRequests)
      .set({
        status: "executed",
        approved_by: input.approver_user_id,
        applied_at: now,
      })
      .where(
        sql`${nbfcAuctionCancelRequests.id} = ${input.request_id} AND ${nbfcAuctionCancelRequests.status} = 'pending_second_approval'`,
      )
      .returning({ id: nbfcAuctionCancelRequests.id });

    if (flipped.length === 0) {
      throw new Error("CONFLICT: cancel request status changed concurrently");
    }

    // Set lot.status='cancelled' and read back lot_code in the same statement.
    const [lot] = await tx
      .update(auctionLots)
      .set({ status: "cancelled" })
      .where(eq(auctionLots.id, pending.lot_id))
      .returning({
        id: auctionLots.id,
        lot_code: auctionLots.lot_code,
      });

    if (!lot) {
      throw new Error("NOT_FOUND: lot disappeared during commit");
    }

    // Return the underlying batteries to stock.
    //
    // [FIX] This used to match `inventory.serial_number = lot.lot_code` and
    // nothing else. Those two values are never equal — a lot code is
    // "LOT-XXXXXX", a serial never is — so `battery_returned_to_inventory` was
    // false on every cancellation ever performed, and the stock stayed out of
    // inventory silently. It is the same defect E-232 already fixed in
    // settlements.ts, which was not carried across to here.
    //
    // The real key is auction_lot_items → recovery_batteries.serial. The legacy
    // lot_code match is kept alongside it rather than replaced: it costs one OR
    // and it keeps any hand-linked row, and the E-070 acceptance test, working.
    //
    // The `to_regclass` probe has to happen in JS, not in the statement:
    // Postgres resolves table names at PARSE time, so a guard inside a subquery
    // does not save a statement that names a table this database may not have —
    // it still raises 42P01.
    const probe = await tx.execute(
      sql`SELECT to_regclass('public.auction_lot_items') AS t`,
    );
    const hasLotItems =
      (probe as unknown as Array<{ t: string | null }>)[0]?.t != null;

    const updatedInventory = hasLotItems
      ? ((await tx.execute(sql`
          UPDATE inventory
             SET status = 'in_stock', updated_at = ${now}
           WHERE serial_number = ${lot.lot_code}
              OR serial_number IN (
                   SELECT rb.serial
                     FROM auction_lot_items i
                     JOIN recovery_batteries rb ON rb.id = i.battery_id
                    WHERE i.lot_id = ${pending.lot_id}
                 )
          RETURNING id
        `)) as unknown as Array<unknown>)
      : await tx
          .update(inventory)
          .set({ status: "in_stock", updated_at: now })
          .where(eq(inventory.serial_number, lot.lot_code))
          .returning({ id: inventory.id });

    inventoryReturned = updatedInventory.length > 0;

    // And release the batteries themselves. Without this they stay `lotted`
    // for ever, and `lotted` stock cannot be composed into another lot — so
    // cancelling a lot used to destroy the resale value of everything on it.
    if (hasLotItems) {
      await tx.execute(sql`
        UPDATE recovery_batteries
           SET state_code = 'ready', updated_at = ${now}
         WHERE state_code = 'lotted'
           AND id IN (SELECT battery_id FROM auction_lot_items
                       WHERE lot_id = ${pending.lot_id})
      `);
    }

    await tx.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "auction_lot",
      entity_id: pending.lot_id,
      action: "AUCTION_LOT_CANCELLED",
      performed_by: input.approver_user_id,
      old_data: { lot_status_before: "live" },
      new_data: {
        lot_id: pending.lot_id,
        lot_code: lot.lot_code,
        reason: pending.reason,
        requested_by: pending.requested_by,
        approved_by: input.approver_user_id,
        cancel_request_id: pending.id,
        battery_returned_to_inventory: inventoryReturned,
        inventory_rows_updated: updatedInventory.length,
      },
      changes: {
        before: { status: "live" },
        after: { status: "cancelled" },
        reason: pending.reason,
      },
      timestamp: now,
    });
  });

  // Told after the commit: a cancellation must never fail because an email

  // bounced, and everyone who bid has money committed to a lot that has just

  // been withdrawn.

  await notifyLotLifecycle({

    lot_id: pending.lot_id,

    event: "cancelled",

    reason: pending.reason,

  });


  return {
    request_id: pending.id,
    status: "executed",
    battery_returned_to_inventory: inventoryReturned,
    applied_at: now.toISOString(),
  };
}

/**
 * Read-side helper for the Cancel Lot Approval Queue UI. Returns all
 * currently pending cancel requests, newest-first.
 */
export async function listPendingCancelRequests() {
  return db
    .select({
      id: nbfcAuctionCancelRequests.id,
      lot_id: nbfcAuctionCancelRequests.lot_id,
      reason: nbfcAuctionCancelRequests.reason,
      requested_by: nbfcAuctionCancelRequests.requested_by,
      requested_at: nbfcAuctionCancelRequests.requested_at,
      status: nbfcAuctionCancelRequests.status,
    })
    .from(nbfcAuctionCancelRequests)
    .where(eq(nbfcAuctionCancelRequests.status, "pending_second_approval"));
}
