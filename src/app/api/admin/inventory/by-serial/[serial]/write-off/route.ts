import { db } from "@/lib/db";
import { inventory, inventoryWriteOffs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler, generateId } from "@/lib/api-utils";
import { logInventoryEvent } from "@/lib/inventory/events";
import { normalizeInventoryStatus } from "@/lib/inventory/status";

const HIGH_VALUE_APPROVAL_THRESHOLD = Number(
  process.env.INVENTORY_WRITE_OFF_SECOND_APPROVAL_THRESHOLD ?? "100000",
);

const bodySchema = z.object({
  reason: z.enum([
    "damaged",
    "stolen",
    "defective",
    "expired",
    "lost_in_transit",
    "other",
  ]),
  reasonNotes: z.string().optional(),
  supportingDocUrl: z.string().url().optional(),
  writeOffValue: z.coerce.number().positive().optional(),
  secondApprovedBy: z.string().uuid().optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ serial: string }> }) => {
    const user = await requireInventoryAdmin();
    const { serial } = await ctx.params;
    const body = bodySchema.parse(await req.json());

    if (body.reason === "other" && (!body.reasonNotes || body.reasonNotes.trim().length < 20)) {
      return errorResponse("Reason notes must be at least 20 characters for 'other'", 400);
    }

    const [row] = await db
      .select({
        id: inventory.id,
        serial_number: inventory.serial_number,
        status: inventory.status,
        invoice_value: inventory.inventory_amount,
      })
      .from(inventory)
      .where(eq(inventory.serial_number, serial))
      .limit(1);
    if (!row) return errorResponse(`Inventory serial ${serial} not found`, 404);

    const status = normalizeInventoryStatus(row.status);
    if (status !== "available") {
      return errorResponse("Only available items can be written off.", 409);
    }

    const invoiceValue = Number(row.invoice_value || 0);
    const writeOffValue = Number(body.writeOffValue ?? invoiceValue);
    const requiresSecondApproval = writeOffValue >= HIGH_VALUE_APPROVAL_THRESHOLD;
    if (requiresSecondApproval && !body.secondApprovedBy) {
      return errorResponse(
        `Second approval required for write-off value >= ${HIGH_VALUE_APPROVAL_THRESHOLD}`,
        400,
      );
    }

    const now = new Date();
    const writeOffId = await generateId("WO");
    await db.transaction(async (tx) => {
      await tx.insert(inventoryWriteOffs).values({
        id: writeOffId,
        inventory_id: row.id,
        serial_number: serial,
        reason: body.reason,
        reason_notes: body.reasonNotes ?? null,
        supporting_doc_url: body.supportingDocUrl ?? null,
        write_off_value: writeOffValue.toString(),
        requires_second_approval: requiresSecondApproval,
        approval_status: requiresSecondApproval ? "approved" : "completed",
        second_approved_by: body.secondApprovedBy ?? null,
        second_approved_at: requiresSecondApproval ? now : null,
        written_off_by: user.id,
        written_off_at: now,
        created_at: now,
        updated_at: now,
      });

      await tx
        .update(inventory)
        .set({
          status: "written_off",
          updated_at: now,
        })
        .where(eq(inventory.id, row.id));

      await logInventoryEvent({
        tx,
        serialNumber: serial,
        inventoryId: row.id,
        eventType: "written_off",
        fromStatus: row.status,
        toStatus: "written_off",
        performedBy: user.id,
        notes: body.reasonNotes ?? null,
        metadata: {
          reason: body.reason,
          supportingDocUrl: body.supportingDocUrl ?? null,
          writeOffValue,
          writeOffId,
        },
        performedAt: now,
      });
    });

    return successResponse({
      serialNumber: serial,
      status: "written_off",
      writeOffId,
      writeOffValue,
      requiresSecondApproval,
    });
  },
);
