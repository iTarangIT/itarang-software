import { db } from "@/lib/db";
import { inventory, accounts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";

// GET: full read-only detail card.
// PATCH: non-critical BRD editable fields.

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
  physical_condition: z.enum(["new", "refurbished", "demo"]).nullable().optional(),
  oem_warranty_clauses: z.string().nullable().optional(),
});

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ itemId: string }> }) => {
    await requireInventoryAdmin();
    const { itemId } = await ctx.params;
    const body = patchSchema.parse(await req.json());

    const existing = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(eq(inventory.id, itemId))
      .limit(1);
    if (!existing[0]) return errorResponse(`Inventory ${itemId} not found`, 404);

    await db
      .update(inventory)
      .set({
        warehouse_location: body.warehouse_location ?? null,
        iot_imei_no: body.iot_imei_no ?? null,
        iot_enabled:
          body.iot_imei_no !== undefined
            ? Boolean(body.iot_imei_no && body.iot_imei_no.trim() !== "")
            : undefined,
        physical_condition: body.physical_condition ?? undefined,
        oem_warranty_clauses: body.oem_warranty_clauses ?? undefined,
        updated_at: new Date(),
      })
      .where(eq(inventory.id, itemId));

    return successResponse({ id: itemId });
  },
);
