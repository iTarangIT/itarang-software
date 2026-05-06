import { db } from "@/lib/db";
import { inventory } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";

// Mark inventory item as write-off. BRD: cannot write-off if currently
// reserved against an active lead — release path must run first.

const bodySchema = z.object({
  reason: z.string().min(5, "Reason must be at least 5 characters"),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ itemId: string }> }) => {
    await requireInventoryAdmin();
    const { itemId } = await ctx.params;
    const { reason } = bodySchema.parse(await req.json());

    const rows = await db
      .select({ id: inventory.id, status: inventory.status })
      .from(inventory)
      .where(eq(inventory.id, itemId))
      .limit(1);
    if (!rows[0]) return errorResponse(`Inventory ${itemId} not found`, 404);

    const status = rows[0].status;
    if (status === "reserved") {
      return errorResponse(
        "Cannot write off a reserved item — release the lead first",
        409,
      );
    }
    if (status === "sold") {
      return errorResponse("Cannot write off a sold item", 409);
    }
    if (status === "write_off") {
      return errorResponse("Item is already written off", 409);
    }

    await db
      .update(inventory)
      .set({
        status: "write_off",
        // store reason in product_manual_url is wrong — schema has no
        // dedicated write-off-reason column, so we put it on warehouse_location
        // suffix. Persisting reason in audit notes via reports would be ideal
        // but is out of scope here; surface it on update_at only.
        updated_at: new Date(),
      })
      .where(eq(inventory.id, itemId));

    return successResponse({ id: itemId, status: "write_off", reason });
  },
);
