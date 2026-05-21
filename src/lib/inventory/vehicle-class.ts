// Canonical vehicle classes for the dealer lead form.
//
// Real `inventory.asset_category` values are messy ("3W", "3W Batteries",
// "3-Wheeler", "3 Wheeler", …), so we bucket them by the leading vehicle-class
// token. Shared by the lead "categories" and "products" endpoints so both
// attribute inventory to a class identically — the "N in stock" total and the
// Product-type list must always agree.

export const CANONICAL_VEHICLE_CLASSES = [
  { class: "2W", slug: "2w", patterns: [/^2\s*-?\s*W/i, /2\s*-?\s*Wheeler/i] },
  { class: "3W", slug: "3w", patterns: [/^3\s*-?\s*W/i, /3\s*-?\s*Wheeler/i] },
  { class: "4W", slug: "4w", patterns: [/^4\s*-?\s*W/i, /4\s*-?\s*Wheeler/i] },
] as const;

/** Bucket a raw asset_category string into "2W" / "3W" / "4W", or null. */
export function canonicalizeAssetCategory(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  for (const c of CANONICAL_VEHICLE_CLASSES) {
    if (c.patterns.some((p) => p.test(trimmed))) return c.class;
  }
  return null; // unknown — drop
}

/** Resolve a category slug ("3w") to its canonical class ("3W"), or null. */
export function vehicleClassFromSlug(slug: string): string | null {
  const s = slug.trim().toLowerCase();
  return CANONICAL_VEHICLE_CLASSES.find((c) => c.slug === s)?.class ?? null;
}
