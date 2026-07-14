/**
 * POST /api/buyback/requests/:id/lines
 *
 * Add a battery SKU line. Quantity N auto-generates Unit 1..N in the same
 * transaction (BRD P3) — units are never created lazily, because photos and
 * provenance attach to them and a half-populated line is a data bug waiting to
 * happen.
 *
 * The estimated price and the price-book version come from the CATALOG, not from
 * the client. A dealer may edit their asking price and the measured voltage; they
 * may not edit the spec or invent a price book (M16 AC: a catalog edit must never
 * move an open request's reference price).
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
  buybackBatches,
  buybackLines,
  buybackUnits,
  catalogVariants,
} from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

/** A sane ceiling: the intake UI only renders 20 unit chips before collapsing. */
const MAX_QTY_PER_LINE = 500;

const bodySchema = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_QTY_PER_LINE),
  condition: z.enum(["WORKING", "DEAD"]),
  /** Dealer-editable. Defaults to the catalog estimate for the chosen condition. */
  expected_price_per_unit: z.number().nonnegative().nullish(),
  measured_voltage: z.number().nonnegative().nullish(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);
    const body = bodySchema.parse(await req.json());

    const [variant] = await db
      .select()
      .from(catalogVariants)
      .where(and(eq(catalogVariants.id, body.variant_id), eq(catalogVariants.active, true)))
      .limit(1);

    if (!variant) throw new NotFoundError("Battery variant not found in the catalog.");

    const line = await db.transaction(async (tx) => {
      // Lines can only be added while the request is still the dealer's to edit.
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");
      if (deal.status !== "DRAFT" && deal.status !== "INFO_REQUESTED") {
        throw new ValidationError(
          `Battery lines cannot be added while the request is ${deal.status}.`,
        );
      }

      const [batch] = await tx
        .select()
        .from(buybackBatches)
        .where(eq(buybackBatches.request_id, request.id))
        .limit(1);

      if (!batch) throw new NotFoundError("Batch not found for this request.");

      // The catalog decides the default price for the chosen condition — the
      // prototype's bWork/bDead split.
      const catalogPrice =
        body.condition === "DEAD"
          ? variant.est_buyback_price_dead
          : variant.est_buyback_price_working;

      const [row] = await tx
        .insert(buybackLines)
        .values({
          batch_id: batch.id,
          variant_id: variant.id,
          quantity: body.quantity,
          condition: body.condition,
          measured_voltage: body.measured_voltage?.toString() ?? null,
          expected_price_per_unit:
            body.expected_price_per_unit?.toString() ?? catalogPrice ?? null,
          // Snapshot, so a later catalog edit cannot move this request.
          price_book_version_at_create: variant.price_book_version,
        })
        .returning();

      // qty N → Unit 1..N, right now, in this transaction.
      await tx.insert(buybackUnits).values(
        Array.from({ length: body.quantity }, (_, i) => ({
          line_id: row.id,
          unit_no: i + 1,
        })),
      );

      return row;
    });

    return successResponse(
      {
        line_id: line.id,
        variant_id: line.variant_id,
        quantity: line.quantity,
        condition: line.condition,
        expected_price_per_unit: line.expected_price_per_unit,
        measured_voltage: line.measured_voltage,
        units_created: line.quantity,
      },
      201,
    );
  },
);
