/**
 * GET  /api/admin/buyback/catalog  — the price book, as the admin sees it
 * POST /api/admin/buyback/catalog  — add a variant (M16)
 *
 * The list carries `days_since_review` alongside the rows because the review
 * nudge is a property of the CATALOG, not of any one variant: the screen has to
 * be able to say "nobody has looked at these prices in three weeks" before an
 * admin trusts a single number on it.
 *
 * A new variant is born at price_book_version 1 AND gets a version-1 row in
 * catalog_price_history in the same transaction. Without that seed row, the very
 * first prices a variant ever had would be the only ones with no audit trail —
 * and a request raised against version 1 would point at a version that history
 * cannot explain. repriceVariant() keeps the invariant from version 2 onwards;
 * this keeps it from version 1.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { daysSinceReview, listVariants } from "@/lib/buyback/catalog";
import { ValidationError } from "@/lib/buyback/errors";
import { db } from "@/lib/db";
import { catalogVariants } from "@/lib/db/schema";

export const runtime = "nodejs";

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  // Admins need to SEE deactivated variants — a variant is only ever retired,
  // never deleted, so `?all=1` is the only way to know one exists at all.
  const includeInactive = new URL(req.url).searchParams.get("all") === "1";

  const [variants, days] = await Promise.all([listVariants(includeInactive), daysSinceReview()]);

  return successResponse({ variants, days_since_review: days });
});

const bodySchema = z.object({
  /** The label the dealer picks from, e.g. "60V 120Ah Li-ion". */
  type: z.string().min(2),
  chemistry: z.string().min(1).optional(),
  voltage: z.number().positive(),
  ah: z.number().positive(),
  unit_price: z.number().nonnegative().optional(),
  est_buyback_price_working: z.number().nonnegative().optional(),
  est_buyback_price_dead: z.number().nonnegative().optional(),
});

/** numeric() columns round-trip as strings; undefined must stay NULL, not "undefined". */
const numeric = (value: number | undefined) => (value === undefined ? null : value.toString());

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireBuybackAdmin();
  const body = bodySchema.parse(await req.json());

  const variant = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(catalogVariants)
      .values({
        type: body.type,
        chemistry: body.chemistry ?? null,
        voltage: body.voltage.toString(),
        ah: body.ah.toString(),
        unit_price: numeric(body.unit_price),
        est_buyback_price_working: numeric(body.est_buyback_price_working),
        est_buyback_price_dead: numeric(body.est_buyback_price_dead),
        price_book_version: 1,
      })
      // UNIQUE(type, voltage, ah). A duplicate is an admin mistake, not a server
      // fault — swallow the constraint and answer with a sentence they can act on.
      .onConflictDoNothing()
      .returning({ id: catalogVariants.id });

    if (!row) {
      throw new ValidationError(
        `A "${body.type}" variant at ${body.voltage}V ${body.ah}Ah already exists. Edit its prices instead of adding it again.`,
      );
    }

    await tx.execute(sql`
      INSERT INTO catalog_price_history
        (variant_id, price_book_version, unit_price, est_buyback_price_working,
         est_buyback_price_dead, changed_by, note)
      VALUES (${row.id}, 1, ${numeric(body.unit_price)},
              ${numeric(body.est_buyback_price_working)}, ${numeric(body.est_buyback_price_dead)},
              ${actor.id}, ${"Variant created."})
    `);

    return { id: row.id, type: body.type, price_book_version: 1 };
  });

  return successResponse(variant, 201);
});
