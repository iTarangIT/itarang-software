import { eq } from "drizzle-orm";
import { z } from "zod";

import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { productMasterParaphernalia } from "@/lib/db/schema";

const patchSchema = z.object({
  displayLabel: z.string().trim().min(1).max(100).optional(),
  compatibleCategories: z.array(z.string().trim().min(1)).optional(),
  maxQtyPerLead: z.number().int().min(0).max(5000).optional(),
  harnessVariant: z.boolean().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ itemTypeCode: string }> }) => {
    await requireInventoryAdmin();
    const { itemTypeCode } = await ctx.params;

    const [row] = await db
      .select()
      .from(productMasterParaphernalia)
      .where(eq(productMasterParaphernalia.item_type_code, itemTypeCode))
      .limit(1);
    if (!row) return errorResponse(`Paraphernalia item '${itemTypeCode}' not found`, 404);

    return successResponse(row);
  },
);

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ itemTypeCode: string }> }) => {
    await requireInventoryAdmin();
    const { itemTypeCode } = await ctx.params;
    const body = patchSchema.parse(await req.json());

    const [existing] = await db
      .select({ id: productMasterParaphernalia.id })
      .from(productMasterParaphernalia)
      .where(eq(productMasterParaphernalia.item_type_code, itemTypeCode))
      .limit(1);
    if (!existing) return errorResponse(`Paraphernalia item '${itemTypeCode}' not found`, 404);

    const [updated] = await db
      .update(productMasterParaphernalia)
      .set({
        display_label: body.displayLabel,
        compatible_categories: body.compatibleCategories,
        max_qty_per_lead: body.maxQtyPerLead,
        harness_variant: body.harnessVariant,
        status: body.status,
        updated_at: new Date(),
      })
      .where(eq(productMasterParaphernalia.id, existing.id))
      .returning();

    return successResponse(updated);
  },
);

export const DELETE = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ itemTypeCode: string }> }) => {
    await requireInventoryAdmin();
    const { itemTypeCode } = await ctx.params;

    const [existing] = await db
      .select({ id: productMasterParaphernalia.id })
      .from(productMasterParaphernalia)
      .where(eq(productMasterParaphernalia.item_type_code, itemTypeCode))
      .limit(1);
    if (!existing) return errorResponse(`Paraphernalia item '${itemTypeCode}' not found`, 404);

    await db
      .update(productMasterParaphernalia)
      .set({ status: "inactive", updated_at: new Date() })
      .where(eq(productMasterParaphernalia.id, existing.id));

    return successResponse({ itemTypeCode, status: "inactive" });
  },
);
