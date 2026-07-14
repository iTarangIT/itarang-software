/**
 * GET /api/buyback/catalog/variants
 *
 * The SKU picker on the intake page (M02/M16). Every V+Ah combination is its own
 * variant (BRD P1), and each carries TWO estimated buyback prices — Working and
 * Dead — because the price the dealer is quoted depends on the condition they
 * pick, not just the SKU.
 *
 * Returns price_book_version with each row: the intake route stamps it onto the
 * line, so a later catalog edit can never move an open request's reference price.
 */

import { asc, eq } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { catalogVariants } from "@/lib/db/schema";
import { BUYBACK_ADMIN_ROLES } from "@/lib/buyback/auth";

export const runtime = "nodejs";

export const GET = withErrorHandler(async () => {
  // Both sides read the catalog: dealers to pick a SKU, admins to review one.
  await requireRole(["dealer", ...BUYBACK_ADMIN_ROLES]);

  const rows = await db
    .select({
      id: catalogVariants.id,
      type: catalogVariants.type,
      chemistry: catalogVariants.chemistry,
      voltage: catalogVariants.voltage,
      ah: catalogVariants.ah,
      est_buyback_price_working: catalogVariants.est_buyback_price_working,
      est_buyback_price_dead: catalogVariants.est_buyback_price_dead,
      price_book_version: catalogVariants.price_book_version,
    })
    .from(catalogVariants)
    .where(eq(catalogVariants.active, true))
    .orderBy(asc(catalogVariants.voltage), asc(catalogVariants.ah));

  return successResponse({ variants: rows });
});
