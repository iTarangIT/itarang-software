import { db } from "@/lib/db";
import { inventory, accounts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";

// GET — full read-only detail card.
// PATCH — only non-critical fields are editable per BRD: warehouse_location,
// iot_imei_no, physical_condition_notes (we use product_manual_url field as
// a free-text notes proxy is NOT correct; we add notes via warehouse_location
// extension — BRD allows physical_condition_notes which is not in schema, so
// we limit to warehouse_location + iot_imei_no for now).

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ itemId: string }> }) => {
    await requireInventoryAdmin();
    const { itemId } = await ctx.params;

    const rows = await db
      .select({
        item: inventory,
        dealer_name: accounts.business_entity_name,
      })
      .from(inventory)
      .leftJoin(accounts, eq(accounts.id, inventory.dealer_id))
      .where(eq(inventory.id, itemId))
      .limit(1);

    if (!rows[0]) return errorResponse(`Inventory ${itemId} not found`, 404);
    return successResponse(rows[0]);
  },
);

const patchSchema = z.object({
  warehouse_location: z.string().nullable().optional(),
  iot_imei_no: z.string().nullable().optional(),
});

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ itemId: string }> }) => {
    await requireInventoryAdmin();
    const { itemId } = await ctx.params;
    const body = patchSchema.parse(await req.json());

    const existing = await db
      .select({ id: inventory.id, status: inventory.status })
      .from(inventory)
      .where(eq(inventory.id, itemId))
      .limit(1);
    if (!existing[0]) return errorResponse(`Inventory ${itemId} not found`, 404);

    await db
      .update(inventory)
      .set({
        warehouse_location: body.warehouse_location ?? null,
        iot_imei_no: body.iot_imei_no ?? null,
        updated_at: new Date(),
      })
      .where(eq(inventory.id, itemId));

    return successResponse({ id: itemId });
  },
);
