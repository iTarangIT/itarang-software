/**
 * /api/buyback/pickup-addresses
 *
 * The dealer's pickup locations ("Shop — Nashik", "Warehouse — Pune").
 *
 * `accounts` holds only one address, but the intake page offers a choice, so
 * these live in their own table (E-185). Sprint 1 is order-level: one address per
 * request. Per-batch and per-line pickup is M05, Sprint 3 — the hierarchy is
 * already in the schema, nothing here will need to move.
 */

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackPickupAddresses } from "@/lib/db/schema";
import { requireDealer } from "@/lib/buyback/auth";

export const runtime = "nodejs";

export const GET = withErrorHandler(async () => {
  const actor = await requireDealer();

  const addresses = await db
    .select()
    .from(buybackPickupAddresses)
    .where(
      and(
        eq(buybackPickupAddresses.entity_id, actor.entityId!),
        eq(buybackPickupAddresses.active, true),
      ),
    )
    .orderBy(desc(buybackPickupAddresses.is_default));

  return successResponse({ addresses });
});

const createSchema = z.object({
  label: z.string().min(1).max(120),
  address_line1: z.string().min(1).max(300),
  address_line2: z.string().max(300).nullish(),
  city: z.string().max(120).nullish(),
  state: z.string().max(120).nullish(),
  pincode: z.string().regex(/^\d{6}$/, "Pincode must be 6 digits").nullish(),
  contact_name: z.string().max(120).nullish(),
  contact_phone: z.string().max(20).nullish(),
  is_default: z.boolean().default(false),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireDealer();
  const body = createSchema.parse(await req.json());

  const [row] = await db
    .insert(buybackPickupAddresses)
    .values({ ...body, entity_id: actor.entityId! })
    .returning();

  return successResponse({ address: row }, 201);
});
