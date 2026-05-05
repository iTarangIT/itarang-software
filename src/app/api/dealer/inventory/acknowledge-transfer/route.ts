import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  accounts,
  inventory,
  inventoryTransfers,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { notifyInventoryTransferAcknowledged } from "@/lib/notifications";

// BRD V2 §5.4 — target dealer acknowledges receipt of a pending transfer.
// On ack: flips inventory.dealer_id to the target dealer, status='available',
// closes the transfer record. Body may include partial serial list — only
// those rows are flipped (BRD allows per-serial acknowledgement).

const BodySchema = z.object({
  transferId: z.string().min(1),
  // If omitted or empty, ack all serials in the transfer.
  serials: z.array(z.string().min(1)).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole(["dealer"]);
    const body = BodySchema.parse(await req.json());

    const [transfer] = await db
      .select()
      .from(inventoryTransfers)
      .where(eq(inventoryTransfers.id, body.transferId))
      .limit(1);
    if (!transfer) {
      return NextResponse.json(
        { success: false, error: { message: "Transfer not found." } },
        { status: 404 },
      );
    }
    if (transfer.target_dealer_id !== user.dealer_id) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Only the target dealer can acknowledge this transfer." },
        },
        { status: 403 },
      );
    }
    if (transfer.status !== "pending_acknowledgement") {
      return NextResponse.json(
        {
          success: false,
          error: { message: `Transfer is already ${transfer.status}.` },
        },
        { status: 400 },
      );
    }

    const allSerials = (transfer.serials as string[]) ?? [];
    const toAck =
      body.serials && body.serials.length > 0
        ? body.serials.filter((s) => allSerials.includes(s))
        : allSerials;
    if (toAck.length === 0) {
      return NextResponse.json(
        { success: false, error: { message: "No matching serials in transfer." } },
        { status: 400 },
      );
    }

    const now = new Date();

    await db.transaction(async (tx) => {
      // Flip inventory rows: assign to target dealer, set status='available'
      // and bump allocated_to_dealer_at so the new dealer's "freshly received"
      // KPIs roll up correctly.
      await tx
        .update(inventory)
        .set({
          dealer_id: transfer.target_dealer_id,
          status: "available",
          allocated_to_dealer_at: now,
          updated_at: now,
        })
        .where(
          and(
            inArray(inventory.serial_number, toAck),
            eq(inventory.status, "transferred_out"),
          ),
        );

      // Mark transfer completed if every serial was acked, otherwise keep it
      // pending so the remaining serials can be ack'd later.
      const acknowledgedAll = toAck.length === allSerials.length;
      await tx
        .update(inventoryTransfers)
        .set(
          acknowledgedAll
            ? {
                status: "completed",
                acknowledged_by: user.id,
                acknowledged_at: now,
                updated_at: now,
              }
            : {
                acknowledged_by: user.id,
                acknowledged_at: now,
                updated_at: now,
              },
        )
        .where(eq(inventoryTransfers.id, transfer.id));
    });

    // Post-commit: notify source dealer that transfer is (partially) acked.
    const [targetDealer] = await db
      .select({ business_entity_name: accounts.business_entity_name })
      .from(accounts)
      .where(eq(accounts.id, transfer.target_dealer_id))
      .limit(1);
    notifyInventoryTransferAcknowledged({
      sourceDealerId: transfer.source_dealer_id,
      transferId: transfer.id,
      serialCount: toAck.length,
      targetDealerName: targetDealer?.business_entity_name ?? null,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        transferId: transfer.id,
        acknowledged: toAck.length,
        remaining: allSerials.length - toAck.length,
        status: toAck.length === allSerials.length ? "completed" : "pending_acknowledgement",
      },
    });
  } catch (error) {
    console.error("[Acknowledge Transfer] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to acknowledge transfer";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
