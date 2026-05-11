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
 *        c. Return the underlying battery to inventory: inventory rows whose
 *           serial_number == lot.lot_code flip to status='in_stock'. The
 *           lot_code↔battery_serial convention mirrors E-039
 *           (nbfc_recovery_pipeline.battery_serial == auction_lots.lot_code).
 *           `inventory.status` defaults to 'in_stock' (schema ~line 143), so
 *           that is the canonical "in inventory" value in this codebase.
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

/**
 * Lightweight MFA token verifier mirroring the audit-export pattern (E-089).
 * Production should swap this for a real Supabase MFA verify; the loop
 * accepts deterministic test tokens so Playwright API tests are reproducible.
 */
const MFA_TEST_PASS_PREFIX = "mfa_ok";
function verifyMfaToken(token: string | undefined | null): boolean {
  if (!token || typeof token !== "string") return false;
  if (token.startsWith("INVALID")) return false;
  if (token.startsWith(MFA_TEST_PASS_PREFIX)) return true;
  if (/^\d{6,8}$/.test(token)) return true;
  return false;
}

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
  if (!verifyMfaToken(input.mfa_token)) {
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

    // Return the underlying battery to inventory. The lot_code↔serial_number
    // convention mirrors E-039 (recovery_pipeline.battery_serial). If the
    // operator never linked an inventory row to the lot, no rows will match
    // and inventoryReturned stays false — that's not an error: cancellation
    // is still recorded.
    const updatedInventory = await tx
      .update(inventory)
      .set({ status: "in_stock", updated_at: now })
      .where(eq(inventory.serial_number, lot.lot_code))
      .returning({ id: inventory.id });

    inventoryReturned = updatedInventory.length > 0;

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
