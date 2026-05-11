import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";

import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { productMasterBatteries } from "@/lib/db/schema";

const statusSchema = z.enum(["active", "inactive"]);

const createSchema = z.object({
  modelId: z.string().trim().min(1).max(50),
  modelName: z.string().trim().min(1).max(100),
  compatibleCategories: z.array(z.string().trim().min(1)).default([]),
  compatibleSubCategories: z.array(z.string().trim().min(1)).default([]),
  voltageV: z.number().positive().optional().nullable(),
  capacityAh: z.number().positive().optional().nullable(),
  batteryChemistry: z.string().trim().min(1).max(20).optional().nullable(),
  warrantyMonths: z.number().int().min(0).max(240).default(0),
  iotCompatible: z.boolean().default(false),
  compatibleChargerModels: z.array(z.string().trim().min(1)).default([]),
  status: statusSchema.default("active"),
});

export const GET = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const q = searchParams.get("q")?.trim();

  const where =
    status && status !== "all"
      ? and(
          eq(productMasterBatteries.status, status),
          q
            ? ilike(productMasterBatteries.model_name, `%${q}%`)
            : undefined,
        )
      : q
        ? ilike(productMasterBatteries.model_name, `%${q}%`)
        : undefined;

  const rows = await db.select().from(productMasterBatteries).where(where);
  return successResponse({ items: rows });
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireInventoryAdmin();
  const body = createSchema.parse(await req.json());

  const [existing] = await db
    .select({ id: productMasterBatteries.id })
    .from(productMasterBatteries)
    .where(eq(productMasterBatteries.model_id, body.modelId))
    .limit(1);
  if (existing) {
    return errorResponse(`Battery model '${body.modelId}' already exists`, 409);
  }

  const [created] = await db
    .insert(productMasterBatteries)
    .values({
      model_id: body.modelId,
      model_name: body.modelName,
      compatible_categories: body.compatibleCategories,
      compatible_sub_categories: body.compatibleSubCategories,
      voltage_v: body.voltageV != null ? String(body.voltageV) : null,
      capacity_ah: body.capacityAh != null ? String(body.capacityAh) : null,
      battery_chemistry: body.batteryChemistry ?? null,
      warranty_months: body.warrantyMonths,
      iot_compatible: body.iotCompatible,
      compatible_charger_models: body.compatibleChargerModels,
      status: body.status,
      created_by: user.id,
      updated_at: new Date(),
    })
    .returning();

  return successResponse(created, 201);
});
