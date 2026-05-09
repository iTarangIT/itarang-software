import { db } from "@/lib/db";
import { inventory, productCategories } from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";

// Canonical vehicle classes the lead form should ever offer.
// Real inventory.asset_category values are messy ("3W", "3W Batteries", "3-Wheeler", …),
// so we bucket them by the leading vehicle-class token.
const CANONICAL_CLASSES = [
  { class: "2W", slug: "2w", patterns: [/^2\s*-?\s*W/i, /2\s*-?\s*Wheeler/i] },
  { class: "3W", slug: "3w", patterns: [/^3\s*-?\s*W/i, /3\s*-?\s*Wheeler/i] },
  { class: "4W", slug: "4w", patterns: [/^4\s*-?\s*W/i, /4\s*-?\s*Wheeler/i] },
] as const;

function canonicalizeAssetCategory(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  for (const c of CANONICAL_CLASSES) {
    if (c.patterns.some((p) => p.test(trimmed))) return c.class;
  }
  return null; // unknown — drop
}

export const GET = withErrorHandler(async () => {
  const user = await requireRole(["dealer"]);
  const dealerId = user.dealer_id;
  if (!dealerId) {
    return errorResponse("No dealer account is linked to this user.", 403);
  }

  const stockRows = await db
    .select({
      asset_category: inventory.asset_category,
      available_count: sql<number>`count(*)::int`,
    })
    .from(inventory)
    .where(
      and(
        eq(inventory.dealer_id, dealerId),
        eq(inventory.status, "available"),
      ),
    )
    .groupBy(inventory.asset_category);

  const totals = new Map<string, number>();
  for (const r of stockRows) {
    const canonical = canonicalizeAssetCategory(r.asset_category);
    if (!canonical) continue;
    totals.set(canonical, (totals.get(canonical) ?? 0) + r.available_count);
  }

  const activeSlugs = CANONICAL_CLASSES
    .filter((c) => (totals.get(c.class) ?? 0) > 0)
    .map((c) => c.slug);

  if (activeSlugs.length === 0) {
    return successResponse([]);
  }

  // Resolve each canonical slug to its productCategories UUID so leads store a
  // real FK in product_category_id (the lead column expects a UUID, not a slug).
  const categoryRows = await db
    .select({
      id: productCategories.id,
      slug: productCategories.slug,
    })
    .from(productCategories)
    .where(
      and(
        eq(productCategories.is_active, true),
        inArray(productCategories.slug, activeSlugs),
      ),
    );

  const idBySlug = new Map<string, string>();
  for (const row of categoryRows) idBySlug.set(row.slug, row.id);

  const result = CANONICAL_CLASSES
    .filter((c) => (totals.get(c.class) ?? 0) > 0 && idBySlug.has(c.slug))
    .map((c) => ({
      id: idBySlug.get(c.slug) as string,
      name: c.class,
      slug: c.slug,
      isVehicleCategory: true,
      available_count: totals.get(c.class) ?? 0,
    }));

  return successResponse(result);
});
