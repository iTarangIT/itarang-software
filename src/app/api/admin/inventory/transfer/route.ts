import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { accounts, inventory, inventoryTransfers } from "@/lib/db/schema";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { generateId } from "@/lib/api-utils";
import { notifyInventoryTransferIncoming } from "@/lib/notifications";
import { logInventoryEvent } from "@/lib/inventory/events";

const BodySchema = z.object({
  sourceDealerId: z.string().min(1),
  targetDealerId: z.string().min(1),
  serials: z.array(z.string().min(1)).min(1, "At least one serial required"),
  reason: z.string().min(1).max(500),
});

export async function POST(req: NextRequest) {
  try {
    const admin = await requireInventoryAdmin();
    const body = BodySchema.parse(await req.json());

    if (body.sourceDealerId === body.targetDealerId) {
      return NextResponse.json(
        { success: false, error: { message: "Source and target dealer must differ." } },
        { status: 400 },
      );
    }

    const dealerRows = await db
      .select({ id: accounts.id, name: accounts.business_entity_name })
      .from(accounts)
      .where(inArray(accounts.id, [body.sourceDealerId, body.targetDealerId]));
    const dealerById = new Map(dealerRows.map((d) => [d.id, d]));
    if (!dealerById.has(body.sourceDealerId) || !dealerById.has(body.targetDealerId)) {
      return NextResponse.json(
        { success: false, error: { message: "Dealer not found." } },
        { status: 404 },
      );
    }

    const sourceItems = await db
      .select({
        id: inventory.id,
        serial_number: inventory.serial_number,
        status: inventory.status,
        dealer_id: inventory.dealer_id,
      })
      .from(inventory)
      .where(
        and(
          eq(inventory.dealer_id, body.sourceDealerId),
          inArray(inventory.serial_number, body.serials),
        ),
      );

    const foundBySerial = new Map(sourceItems.map((r) => [r.serial_number ?? "", r]));
    const errors: { serial: string; reason: string }[] = [];
    for (const serial of body.serials) {
      const row = foundBySerial.get(serial);
      if (!row) {
        errors.push({ serial, reason: "Not in source dealer inventory" });
        continue;
      }
      if (row.status !== "available") {
        errors.push({ serial, reason: `Cannot transfer - current status is ${row.status}` });
      }
    }
    if (errors.length > 0) {
      return NextResponse.json(
        { success: false, error: { message: "Some serials cannot be transferred.", errors } },
        { status: 400 },
      );
    }

    const transferId = await generateId("XFER");
    const now = new Date();
    const eligibleIds = sourceItems.map((r) => r.id);

    await db.transaction(async (tx) => {
      await tx.insert(inventoryTransfers).values({
        id: transferId,
        source_dealer_id: body.sourceDealerId,
        target_dealer_id: body.targetDealerId,
        serials: body.serials,
        reason: body.reason,
        initiated_by: admin.id,
        initiated_at: now,
        status: "pending_acknowledgement",
        created_at: now,
        updated_at: now,
      });

      // Mark source inventory as transferred_out. Dealer ownership moves on ack.
      await tx
        .update(inventory)
        .set({
          status: "transferred_out",
          updated_at: now,
        })
        .where(inArray(inventory.id, eligibleIds));

      for (const row of sourceItems) {
        if (!row.serial_number) continue;
        await logInventoryEvent({
          tx,
          serialNumber: row.serial_number,
          inventoryId: row.id,
          eventType: "transfer_initiated",
          fromStatus: row.status,
          toStatus: "transferred_out",
          performedBy: admin.id,
          notes: body.reason,
          metadata: {
            transferId,
            sourceDealerId: body.sourceDealerId,
            targetDealerId: body.targetDealerId,
          },
          performedAt: now,
        });
      }
    });

    notifyInventoryTransferIncoming({
      targetDealerId: body.targetDealerId,
      transferId,
      serialCount: body.serials.length,
      sourceDealerName: dealerById.get(body.sourceDealerId)?.name ?? null,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        transferId,
        status: "pending_acknowledgement",
        serialCount: body.serials.length,
      },
    });
  } catch (error) {
    console.error("[Inventory Transfer] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to initiate transfer";
    return NextResponse.json({ success: false, error: { message } }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireInventoryAdmin();
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const source = searchParams.get("source");
    const target = searchParams.get("target");

    const conditions = [];
    if (status) conditions.push(eq(inventoryTransfers.status, status));
    if (source) conditions.push(eq(inventoryTransfers.source_dealer_id, source));
    if (target) conditions.push(eq(inventoryTransfers.target_dealer_id, target));

    const rows = await db
      .select()
      .from(inventoryTransfers)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(inventoryTransfers.initiated_at));

    return NextResponse.json({ success: true, data: { rows } });
  } catch (error) {
    console.error("[Inventory Transfer List] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to list transfers";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
