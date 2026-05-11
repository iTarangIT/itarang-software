import { eq } from "drizzle-orm";
import { z } from "zod";

import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { productMasterChargers } from "@/lib/db/schema";

const patchSchema = z.object({
  modelName: z.string().trim().min(1).max(100).optional(),
  outputVoltageV: z.number().positive().nullable().optional(),
  outputCurrentA: z.number().positive().nullable().optional(),
  chargingType: z.string().trim().min(1).max(30).nullable().optional(),
  compatibleBatteryModels: z.array(z.string().trim().min(1)).optional(),
  basePrice: z.number().min(0).nullable().optional(),
  warrantyMonths: z.number().int().min(0).max(240).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ modelId: string }> }) => {
    await requireInventoryAdmin();
    const { modelId } = await ctx.params;

    const [row] = await db
      .select()
      .from(productMasterChargers)
      .where(eq(productMasterChargers.model_id, modelId))
      .limit(1);
    if (!row) return errorResponse(`Charger model '${modelId}' not found`, 404);

    return successResponse(row);
  },
);

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ modelId: string }> }) => {
    await requireInventoryAdmin();
    const { modelId } = await ctx.params;
    const body = patchSchema.parse(await req.json());

    const [existing] = await db
      .select({ id: productMasterChargers.id })
      .from(productMasterChargers)
      .where(eq(productMasterChargers.model_id, modelId))
      .limit(1);
    if (!existing) return errorResponse(`Charger model '${modelId}' not found`, 404);

    const [updated] = await db
      .update(productMasterChargers)
      .set({
        model_name: body.modelName,
        output_voltage_v:
          body.outputVoltageV != null ? String(body.outputVoltageV) : body.outputVoltageV,
        output_current_a:
          body.outputCurrentA != null ? String(body.outputCurrentA) : body.outputCurrentA,
        charging_type: body.chargingType,
        compatible_battery_models: body.compatibleBatteryModels,
        base_price: body.basePrice != null ? String(body.basePrice) : body.basePrice,
        warranty_months: body.warrantyMonths,
        status: body.status,
        updated_at: new Date(),
      })
      .where(eq(productMasterChargers.id, existing.id))
      .returning();

    return successResponse(updated);
  },
);

export const DELETE = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ modelId: string }> }) => {
    await requireInventoryAdmin();
    const { modelId } = await ctx.params;

    const [existing] = await db
      .select({ id: productMasterChargers.id })
      .from(productMasterChargers)
      .where(eq(productMasterChargers.model_id, modelId))
      .limit(1);
    if (!existing) return errorResponse(`Charger model '${modelId}' not found`, 404);

    await db
      .update(productMasterChargers)
      .set({ status: "inactive", updated_at: new Date() })
      .where(eq(productMasterChargers.id, existing.id));

    return successResponse({ modelId, status: "inactive" });
  },
);
