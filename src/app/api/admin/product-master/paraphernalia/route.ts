import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";

import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { productMasterParaphernalia } from "@/lib/db/schema";

const statusSchema = z.enum(["active", "inactive"]);

const createSchema = z.object({
  itemTypeCode: z.string().trim().min(1).max(50),
  displayLabel: z.string().trim().min(1).max(100),
  compatibleCategories: z.array(z.string().trim().min(1)).default([]),
  maxQtyPerLead: z.number().int().min(0).max(5000).default(0),
  harnessVariant: z.boolean().default(false),
  hsnCode: z.string().trim().min(1).max(8).nullable().optional(),
  gstRatePct: z.number().min(0).max(50).nullable().optional(),
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
          eq(productMasterParaphernalia.status, status),
          q
            ? ilike(productMasterParaphernalia.display_label, `%${q}%`)
            : undefined,
        )
      : q
        ? ilike(productMasterParaphernalia.display_label, `%${q}%`)
        : undefined;

  const rows = await db.select().from(productMasterParaphernalia).where(where);
  return successResponse({ items: rows });
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireInventoryAdmin();
  const body = createSchema.parse(await req.json());

  const [existing] = await db
    .select({ id: productMasterParaphernalia.id })
    .from(productMasterParaphernalia)
    .where(eq(productMasterParaphernalia.item_type_code, body.itemTypeCode))
    .limit(1);
  if (existing) {
    return errorResponse(`Paraphernalia item '${body.itemTypeCode}' already exists`, 409);
  }

  const [created] = await db
    .insert(productMasterParaphernalia)
    .values({
      item_type_code: body.itemTypeCode,
      display_label: body.displayLabel,
      compatible_categories: body.compatibleCategories,
      max_qty_per_lead: body.maxQtyPerLead,
      harness_variant: body.harnessVariant,
      // Omit when not provided so the E-256 column defaults (18% / 85079090)
      // fill in, rather than inserting an explicit NULL over them.
      hsn_code: body.hsnCode ?? undefined,
      gst_rate_pct: body.gstRatePct != null ? String(body.gstRatePct) : undefined,
      status: body.status,
      created_by: user.id,
      updated_at: new Date(),
    })
    .returning();

  return successResponse(created, 201);
});
