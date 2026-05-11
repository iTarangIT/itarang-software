import { eq } from "drizzle-orm";
import { z } from "zod";

import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { productMasterBatteries } from "@/lib/db/schema";

const patchSchema = z.object({
  modelName: z.string().trim().min(1).max(100).optional(),
  compatibleCategories: z.array(z.string().trim().min(1)).optional(),
  compatibleSubCategories: z.array(z.string().trim().min(1)).optional(),
  voltageV: z.number().positive().nullable().optional(),
  capacityAh: z.number().positive().nullable().optional(),
  batteryChemistry: z.string().trim().min(1).max(20).nullable().optional(),
  warrantyMonths: z.number().int().min(0).max(240).optional(),
  iotCompatible: z.boolean().optional(),
  compatibleChargerModels: z.array(z.string().trim().min(1)).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ modelId: string }> }) => {
    await requireInventoryAdmin();
    const { modelId } = await ctx.params;

    const [row] = await db
      .select()
      .from(productMasterBatteries)
      .where(eq(productMasterBatteries.model_id, modelId))
      .limit(1);
    if (!row) return errorResponse(`Battery model '${modelId}' not found`, 404);

    return successResponse(row);
  },
);

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ modelId: string }> }) => {
    await requireInventoryAdmin();
    const { modelId } = await ctx.params;
    const body = patchSchema.parse(await req.json());

    const [existing] = await db
      .select({ id: productMasterBatteries.id })
      .from(productMasterBatteries)
      .where(eq(productMasterBatteries.model_id, modelId))
      .limit(1);
    if (!existing) return errorResponse(`Battery model '${modelId}' not found`, 404);

    const [updated] = await db
      .update(productMasterBatteries)
      .set({
        model_name: body.modelName,
        compatible_categories: body.compatibleCategories,
        compatible_sub_categories: body.compatibleSubCategories,
        voltage_v: body.voltageV != null ? String(body.voltageV) : body.voltageV,
        capacity_ah: body.capacityAh != null ? String(body.capacityAh) : body.capacityAh,
        battery_chemistry: body.batteryChemistry,
        warranty_months: body.warrantyMonths,
        iot_compatible: body.iotCompatible,
        compatible_charger_models: body.compatibleChargerModels,
        status: body.status,
        updated_at: new Date(),
      })
      .where(eq(productMasterBatteries.id, existing.id))
      .returning();

    return successResponse(updated);
  },
);

export const DELETE = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ modelId: string }> }) => {
    await requireInventoryAdmin();
    const { modelId } = await ctx.params;

    const [existing] = await db
      .select({ id: productMasterBatteries.id })
      .from(productMasterBatteries)
      .where(eq(productMasterBatteries.model_id, modelId))
      .limit(1);
    if (!existing) return errorResponse(`Battery model '${modelId}' not found`, 404);

    await db
      .update(productMasterBatteries)
      .set({ status: "inactive", updated_at: new Date() })
      .where(eq(productMasterBatteries.id, existing.id));

    return successResponse({ modelId, status: "inactive" });
  },
);
