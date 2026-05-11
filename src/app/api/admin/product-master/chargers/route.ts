import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";

import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { productMasterChargers } from "@/lib/db/schema";

const statusSchema = z.enum(["active", "inactive"]);

const createSchema = z.object({
  modelId: z.string().trim().min(1).max(50),
  modelName: z.string().trim().min(1).max(100),
  outputVoltageV: z.number().positive().nullable().optional(),
  outputCurrentA: z.number().positive().nullable().optional(),
  chargingType: z.string().trim().min(1).max(30).nullable().optional(),
  compatibleBatteryModels: z.array(z.string().trim().min(1)).default([]),
  basePrice: z.number().min(0).nullable().optional(),
  warrantyMonths: z.number().int().min(0).max(240).default(0),
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
          eq(productMasterChargers.status, status),
          q
            ? ilike(productMasterChargers.model_name, `%${q}%`)
            : undefined,
        )
      : q
        ? ilike(productMasterChargers.model_name, `%${q}%`)
        : undefined;

  const rows = await db.select().from(productMasterChargers).where(where);
  return successResponse({ items: rows });
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireInventoryAdmin();
  const body = createSchema.parse(await req.json());

  const [existing] = await db
    .select({ id: productMasterChargers.id })
    .from(productMasterChargers)
    .where(eq(productMasterChargers.model_id, body.modelId))
    .limit(1);
  if (existing) {
    return errorResponse(`Charger model '${body.modelId}' already exists`, 409);
  }

  const [created] = await db
    .insert(productMasterChargers)
    .values({
      model_id: body.modelId,
      model_name: body.modelName,
      output_voltage_v: body.outputVoltageV != null ? String(body.outputVoltageV) : null,
      output_current_a: body.outputCurrentA != null ? String(body.outputCurrentA) : null,
      charging_type: body.chargingType ?? null,
      compatible_battery_models: body.compatibleBatteryModels,
      base_price: body.basePrice != null ? String(body.basePrice) : null,
      warranty_months: body.warrantyMonths,
      status: body.status,
      created_by: user.id,
      updated_at: new Date(),
    })
    .returning();

  return successResponse(created, 201);
});
