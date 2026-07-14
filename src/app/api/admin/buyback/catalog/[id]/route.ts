/**
 * GET    /api/admin/buyback/catalog/:id  — this variant's price history
 * PATCH  /api/admin/buyback/catalog/:id  — reprice it
 * DELETE /api/admin/buyback/catalog/:id  — retire it (soft, always)
 *
 * A repricing does NOT touch any open request. Lines copy their price and their
 * price_book_version_at_create at creation time, so an edit here moves the price
 * NEW intake is quoted at, and nothing else. See lib/buyback/catalog.ts.
 *
 * DELETE is a deactivation, never a row removal: buyback_lines.variant_id is a
 * live FK, so a hard delete either fails or (worse, with a cascade) silently
 * shreds the battery lines of requests that are mid-flight. Deactivation only
 * hides the variant from NEW intake — open requests carry on untouched, which is
 * why we allow it even when open_lines > 0 and just report the count back so the
 * UI can say so out loud.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { listVariants, priceHistory, repriceVariant } from "@/lib/buyback/catalog";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The variant plus its open-request count, from the one query that defines what
 * "open" means (catalog.ts). Duplicating that definition here is how the table
 * and the deactivation warning would eventually come to disagree.
 */
async function loadVariant(id: string) {
  const variant = (await listVariants(true)).find((v) => v.id === id);
  if (!variant) throw new NotFoundError("Variant not found.");
  return variant;
}

export const GET = withErrorHandler(async (_req: Request, ctx: Ctx) => {
  await requireBuybackAdmin();
  const { id } = await ctx.params;

  await loadVariant(id);

  return successResponse({ history: await priceHistory(id) });
});

const patchSchema = z
  .object({
    unit_price: z.number().nonnegative().optional(),
    est_buyback_price_working: z.number().nonnegative().optional(),
    est_buyback_price_dead: z.number().nonnegative().optional(),
    note: z.string().max(500).optional(),
  })
  // A PATCH carrying only a note would still bump price_book_version and append a
  // history row identical to the last one — a version that means nothing.
  .refine(
    (b) =>
      b.unit_price !== undefined ||
      b.est_buyback_price_working !== undefined ||
      b.est_buyback_price_dead !== undefined,
    { message: "Give at least one price to change." },
  );

export const PATCH = withErrorHandler(async (req: Request, ctx: Ctx) => {
  const actor = await requireBuybackAdmin();
  const { id } = await ctx.params;

  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.message ?? "Invalid price change.",
      parsed.error.issues,
    );
  }
  const body = parsed.data;

  // repriceVariant throws a bare Error on a missing row (→ 500). Resolve the
  // variant first so an unknown id is the 404 it actually is.
  await loadVariant(id);

  const { version } = await db.transaction((tx) =>
    repriceVariant(
      tx,
      id,
      {
        unit_price: body.unit_price,
        est_buyback_price_working: body.est_buyback_price_working,
        est_buyback_price_dead: body.est_buyback_price_dead,
      },
      actor.id,
      body.note,
    ),
  );

  return successResponse({ id, price_book_version: version });
});

export const DELETE = withErrorHandler(async (_req: Request, ctx: Ctx) => {
  await requireBuybackAdmin();
  const { id } = await ctx.params;

  const variant = await loadVariant(id);

  await db.execute(sql`
    UPDATE catalog_variants SET active = FALSE, updated_at = now() WHERE id = ${id}
  `);

  return successResponse({ id, active: false, open_lines: variant.open_lines ?? 0 });
});
