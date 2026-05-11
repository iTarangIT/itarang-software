import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { accounts, inventory, inventoryTransfers } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { notifyInventoryTransferAcknowledged } from "@/lib/notifications";
import { logInventoryEvent } from "@/lib/inventory/events";

const BodySchema = z.object({
  transferId: z.string().min(1),
  serials: z.array(z.string().min(1)).optional(),
});

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireRole(["dealer"]);
  } catch (error) {
    console.error("[Incoming Transfers] Auth error:", error);
    const message = error instanceof Error ? error.message : "Authentication required";
    return NextResponse.json({ success: false, error: { message } }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const conditions = [eq(inventoryTransfers.target_dealer_id, user.dealer_id!)];
  if (status && status !== "all") {
    conditions.push(eq(inventoryTransfers.status, status));
  }

  try {
    const rows = await db
      .select()
      .from(inventoryTransfers)
      .where(and(...conditions))
      .orderBy(inventoryTransfers.initiated_at);

    return NextResponse.json({ success: true, data: { rows } });
  } catch (error) {
    // Defensive degrade: a missing inventory_transfers table (un-applied migration)
    // or any other DB read failure must not surface raw SQL into the dealer UI.
    console.error("[Incoming Transfers] Query failed:", error);
    return NextResponse.json({
      success: true,
      data: { rows: [], warning: "Incoming transfers temporarily unavailable" },
    });
  }
}

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
        { success: false, error: { message: "Only target dealer can acknowledge." } },
        { status: 403 },
      );
    }
    if (transfer.status !== "pending_acknowledgement") {
      return NextResponse.json(
        { success: false, error: { message: `Transfer is already ${transfer.status}.` } },
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
      const targetRows = await tx
        .select({ id: inventory.id, serial_number: inventory.serial_number, status: inventory.status })
        .from(inventory)
        .where(
          and(
            inArray(inventory.serial_number, toAck),
            eq(inventory.dealer_id, transfer.source_dealer_id),
            eq(inventory.status, "transferred_out"),
          ),
        );

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
            eq(inventory.dealer_id, transfer.source_dealer_id),
            eq(inventory.status, "transferred_out"),
          ),
        );

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

      for (const row of targetRows) {
        if (!row.serial_number) continue;
        await logInventoryEvent({
          tx,
          serialNumber: row.serial_number,
          inventoryId: row.id,
          eventType: "transfer_received",
          fromStatus: row.status,
          toStatus: "available",
          performedBy: user.id,
          notes: `Transfer ${transfer.id} acknowledged`,
          metadata: {
            transferId: transfer.id,
            sourceDealerId: transfer.source_dealer_id,
            targetDealerId: transfer.target_dealer_id,
          },
          performedAt: now,
        });
      }
    });

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
    const message = error instanceof Error ? error.message : "Failed to acknowledge transfer";
    return NextResponse.json({ success: false, error: { message } }, { status: 400 });
  }
}
