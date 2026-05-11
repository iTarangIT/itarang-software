import { db } from "@/lib/db";
import { inventory, inventoryWriteOffs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler, generateId } from "@/lib/api-utils";
import { logInventoryEvent } from "@/lib/inventory/events";
import { normalizeInventoryStatus } from "@/lib/inventory/status";

// Mark inventory item as write-off. BRD: cannot write-off if currently
// reserved against an active lead — release path must run first.

const bodySchema = z.object({
  reason: z.string().min(5, "Reason must be at least 5 characters"),
  reasonNotes: z.string().optional(),
  supportingDocUrl: z.string().url().optional(),
  writeOffValue: z.coerce.number().positive().optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ itemId: string }> }) => {
    const user = await requireInventoryAdmin();
    const { itemId } = await ctx.params;
    const { reason, reasonNotes, supportingDocUrl, writeOffValue } = bodySchema.parse(await req.json());

    const rows = await db
      .select({ id: inventory.id, status: inventory.status })
      .from(inventory)
      .where(eq(inventory.id, itemId))
      .limit(1);
    if (!rows[0]) return errorResponse(`Inventory ${itemId} not found`, 404);

    const status = normalizeInventoryStatus(rows[0].status);
    if (status === "reserved") {
      return errorResponse(
        "Cannot write off a reserved item — release the lead first",
        409,
      );
    }
    if (status === "sold") {
      return errorResponse("Cannot write off a sold item", 409);
    }
    if (status === "written_off") {
      return errorResponse("Item is already written off", 409);
    }

    const now = new Date();
    const [full] = await db
      .select({
        id: inventory.id,
        serial_number: inventory.serial_number,
        inventory_amount: inventory.inventory_amount,
        status: inventory.status,
      })
      .from(inventory)
      .where(eq(inventory.id, itemId))
      .limit(1);
    if (!full) return errorResponse(`Inventory ${itemId} not found`, 404);

    await db.transaction(async (tx) => {
      await tx
        .update(inventory)
        .set({
          status: "written_off",
          updated_at: now,
        })
        .where(eq(inventory.id, itemId));

      await tx.insert(inventoryWriteOffs).values({
        id: await generateId("WO"),
        inventory_id: itemId,
        serial_number: full.serial_number ?? itemId,
        reason,
        reason_notes: reasonNotes ?? null,
        supporting_doc_url: supportingDocUrl ?? null,
        write_off_value: String(writeOffValue ?? Number(full.inventory_amount ?? 0)),
        requires_second_approval: false,
        approval_status: "completed",
        written_off_by: user.id,
        written_off_at: now,
        created_at: now,
        updated_at: now,
      });

      await logInventoryEvent({
        tx,
        serialNumber: full.serial_number ?? itemId,
        inventoryId: itemId,
        eventType: "written_off",
        fromStatus: full.status,
        toStatus: "written_off",
        performedBy: user.id,
        notes: reasonNotes ?? reason,
        metadata: {
          reason,
          supportingDocUrl: supportingDocUrl ?? null,
          writeOffValue: writeOffValue ?? Number(full.inventory_amount ?? 0),
        },
        performedAt: now,
      });
    });

    return successResponse({ id: itemId, status: "written_off", reason });
  },
);
