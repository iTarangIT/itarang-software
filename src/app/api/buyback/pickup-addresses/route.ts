/**
 * /api/buyback/pickup-addresses
 *
 * The dealer's pickup locations ("Shop — Nashik", "Warehouse — Pune").
 *
 * `accounts` holds only one address, but the intake page offers a choice, so
 * these live in their own table (E-185). Sprint 1 is order-level: one address per
 * request. Per-batch and per-line pickup is M05, Sprint 3 — the hierarchy is
 * already in the schema, nothing here will need to move.
 *
 * E-194 adds `owner_kind` (DEALER | VENDOR | CUSTOMER). Every row here still
 * hangs off the caller's entity_id — this does not let a dealer read a vendor's
 * addresses. It records whose doorstep a given address IS: the battery may be
 * collected from the dealer's shop, or from the driver/previous owner being
 * paid directly, and those are different places with different contacts.
 * Rows written before E-194 are all DEALER, which is what they were.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackPickupAddresses } from "@/lib/db/schema";
import { requireDealer } from "@/lib/buyback/auth";

export const runtime = "nodejs";

/** Mirrors the E-194 CHECK constraint. Kept in sync by that migration's comment. */
export const ADDRESS_OWNER_KINDS = ["DEALER", "VENDOR", "CUSTOMER"] as const;

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
    // The intake preselects addresses[0] and PERSISTS it onto the new request,
    // so this order decides where a battery gets collected from by default.
    //
    //  1. the explicit default, if there is one;
    //  2. then the dealer's own premises ahead of a driver's doorstep or a
    //     recycler's yard — a dealer with no default must not silently start
    //     scheduling pickups from a customer's house;
    //  3. then oldest first, so "the first address" is stable between loads
    //     rather than whatever order the heap happened to return.
    .orderBy(
      desc(buybackPickupAddresses.is_default),
      sql`CASE WHEN ${buybackPickupAddresses.owner_kind} = 'DEALER' THEN 0 ELSE 1 END`,
      asc(buybackPickupAddresses.created_at),
    );

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
  owner_kind: z.enum(ADDRESS_OWNER_KINDS).default("DEALER"),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireDealer();
  const body = createSchema.parse(await req.json());

  const row = await db.transaction(async (tx) => {
    // "Default" has to mean one address, or the intake's preselect is a coin
    // toss between two rows both claiming it. Nothing enforced that before —
    // this route happily wrote a second is_default row — so demote the old one
    // in the same transaction that promotes the new.
    if (body.is_default) {
      await tx
        .update(buybackPickupAddresses)
        .set({ is_default: false })
        .where(
          and(
            eq(buybackPickupAddresses.entity_id, actor.entityId!),
            eq(buybackPickupAddresses.is_default, true),
          ),
        );
    }

    const [created] = await tx
      .insert(buybackPickupAddresses)
      .values({ ...body, entity_id: actor.entityId! })
      .returning();
    return created;
  });

  return successResponse({ address: row }, 201);
});
