/**
 * PATCH  /api/buyback/requests/:id/lines/:lineId  — edit a battery line
 * DELETE /api/buyback/requests/:id/lines/:lineId  — remove it
 *
 * WHY THIS EXISTS: the lines API was POST-only. A line was written the instant the
 * dealer picked a SKU, and every edit after that — quantity, condition, price,
 * measured voltage — was kept in React state and never sent anywhere. A dealer who
 * chose "48V 100Ah", then set the quantity to 2, saw "Unit 1 / Unit 2" and an
 * estimate of ₹8,400 on their screen while the server still held **quantity 1**.
 * They would have submitted a request to sell two batteries and iTarang would have
 * seen one. The ✕ button had the same shape of bug: it removed the row from the
 * page and left the line on the server, so a deleted battery would still have been
 * submitted.
 *
 * THE HARD PART IS THE UNITS. `buyback_units` is one row per physical battery
 * (BRD P3), auto-generated from the quantity, and photos and provenance hang off
 * those units. So a quantity change cannot just UPDATE a number:
 *
 *   · quantity UP   → append the new units. The existing ones keep their photos.
 *   · quantity DOWN → delete only the TRAILING units. Deleting from the front, or
 *                     recreating the whole set, would silently throw away photos
 *                     the dealer had already attached to units 1 and 2 because
 *                     they reduced the count from 5 to 3.
 *
 * Editing is only possible while the request is still a DRAFT. Once it has been
 * submitted, the lines are what iTarang is reviewing and quoting against, and a
 * dealer quietly changing the quantity underneath an open negotiation is exactly
 * the kind of thing the state machine exists to prevent.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { buybackBatches, buybackLines, buybackUnits, catalogVariants } from "@/lib/db/schema";
import { loadOwnRequest, requireDealer } from "@/lib/buyback/auth";
import { NotFoundError, TransitionError } from "@/lib/buyback/errors";
import { lineSpecSchema, specColumnsFromBody } from "@/lib/buyback/line-spec";
import { loadDealForUpdate } from "@/lib/buyback/transition";

export const runtime = "nodejs";

const MAX_QTY_PER_LINE = 500;

const bodySchema = z
  .object({
    // A dealer switching the SKU on a saved row used to be invisible to the
    // server — it kept whatever variant the line was created with while the
    // screen showed the new one, so gate errors and the PO/invoice named a
    // battery the dealer could no longer see (BB-1045).
    variant_id: z.string().uuid().optional(),
    quantity: z.number().int().min(1).max(MAX_QTY_PER_LINE).optional(),
    condition: z.enum(["WORKING", "DEAD"]).optional(),
    expected_price_per_unit: z.number().nonnegative().nullish(),
    measured_voltage: z.number().nonnegative().nullish(),
  })
  // E-191 spec — absent = leave alone, null = clear, value = set.
  .merge(lineSpecSchema);

/** The line, proven to belong to a DRAFT request this dealer owns. */
async function loadEditableLine(requestId: string, lineId: string) {
  const [line] = await db
    .select({
      id: buybackLines.id,
      quantity: buybackLines.quantity,
      batch_id: buybackLines.batch_id,
      variant_id: buybackLines.variant_id,
    })
    .from(buybackLines)
    .innerJoin(buybackBatches, eq(buybackLines.batch_id, buybackBatches.id))
    .where(and(eq(buybackLines.id, lineId), eq(buybackBatches.request_id, requestId)))
    .limit(1);

  if (!line) throw new NotFoundError("Battery line not found.");
  return line;
}

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string; lineId: string }> }) => {
    const { id: requestId, lineId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);
    const body = bodySchema.parse(await req.json());

    const result = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      if (deal.status !== "DRAFT") {
        throw new TransitionError(
          `This request is ${deal.status} and can no longer be edited. ` +
            `Its battery lines are what iTarang is reviewing.`,
        );
      }

      const line = await loadEditableLine(request.id, lineId);

      // A SKU change re-validates against the live catalog and re-snapshots the
      // price book — same lookup as CREATE. An unchanged variant_id (the
      // client now sends it on every save) is a no-op here, not a re-lookup.
      let variantUpdate: { variant_id: string; price_book_version_at_create: number } | null =
        null;
      if (body.variant_id !== undefined && body.variant_id !== line.variant_id) {
        const [variant] = await tx
          .select()
          .from(catalogVariants)
          .where(and(eq(catalogVariants.id, body.variant_id), eq(catalogVariants.active, true)))
          .limit(1);
        if (!variant) throw new NotFoundError("Battery variant not found in the catalog.");
        variantUpdate = {
          variant_id: variant.id,
          price_book_version_at_create: variant.price_book_version,
        };
      }

      await tx
        .update(buybackLines)
        .set({
          ...(variantUpdate ?? {}),
          ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
          ...(body.condition !== undefined ? { condition: body.condition } : {}),
          ...(body.expected_price_per_unit !== undefined
            ? {
                expected_price_per_unit:
                  body.expected_price_per_unit === null
                    ? null
                    : body.expected_price_per_unit.toString(),
              }
            : {}),
          ...(body.measured_voltage !== undefined
            ? {
                measured_voltage:
                  body.measured_voltage === null ? null : body.measured_voltage.toString(),
              }
            : {}),
          // E-191 spec — only the fields present in the body are touched.
          ...specColumnsFromBody(body),
        })
        .where(eq(buybackLines.id, line.id));

      // Reconcile the units to the new quantity.
      let unitsAdded = 0;
      let unitsRemoved = 0;

      if (body.quantity !== undefined && body.quantity !== line.quantity) {
        if (body.quantity > line.quantity) {
          await tx.insert(buybackUnits).values(
            Array.from({ length: body.quantity - line.quantity }, (_, i) => ({
              line_id: line.id,
              unit_no: line.quantity + i + 1,
            })),
          );
          unitsAdded = body.quantity - line.quantity;
        } else {
          // ONLY the trailing units. Units 1..n keep whatever the dealer has
          // already attached to them — reducing 5 to 3 must not wipe the photos
          // on the first three.
          const removed = await tx
            .delete(buybackUnits)
            .where(and(eq(buybackUnits.line_id, line.id), gt(buybackUnits.unit_no, body.quantity)))
            .returning({ id: buybackUnits.id });
          unitsRemoved = removed.length;
        }
      }

      const [{ n }] = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM buyback_units WHERE line_id = ${line.id}
      `)) as unknown as Array<{ n: number }>;

      return { unitsAdded, unitsRemoved, units: n };
    });

    return successResponse({
      line_id: lineId,
      units: result.units,
      units_added: result.unitsAdded,
      units_removed: result.unitsRemoved,
    });
  },
);

export const DELETE = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string; lineId: string }> }) => {
    const { id: requestId, lineId } = await ctx.params;
    const actor = await requireDealer();
    const request = await loadOwnRequest(actor, requestId);

    await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      if (deal.status !== "DRAFT") {
        throw new TransitionError(
          `This request is ${deal.status}. A battery line cannot be removed once iTarang is reviewing it.`,
        );
      }

      const line = await loadEditableLine(request.id, lineId);

      // Units, photos and provenance all cascade from the line (E-185).
      await tx.delete(buybackLines).where(eq(buybackLines.id, line.id));
    });

    return successResponse({ line_id: lineId, deleted: true });
  },
);
