/**
 * Green Energy News — vocabulary (E-306).
 *
 * Kept in code, not a CHECK constraint, so a category can be added without
 * DDL (same convention as sales_targets.metric). The labels are what the CEO
 * sees on the pills; the keys are what Gemini is asked to return and what the
 * column stores.
 */

export const NEWS_CATEGORIES = {
  policy_subsidy: "Policy & subsidies",
  funding_investment: "Funding & investment",
  ev_battery: "EV & batteries",
  solar_wind: "Solar & wind",
  grid_storage: "Grid & storage",
  business_model: "Business models",
  other: "Other",
} as const;

export type NewsCategory = keyof typeof NEWS_CATEGORIES;

export const NEWS_CATEGORY_KEYS = Object.keys(NEWS_CATEGORIES) as NewsCategory[];

export const NEWS_REGIONS = {
  india: "India",
  world: "World",
} as const;

export type NewsRegion = keyof typeof NEWS_REGIONS;

export function isNewsCategory(v: unknown): v is NewsCategory {
  return typeof v === "string" && v in NEWS_CATEGORIES;
}

export function isNewsRegion(v: unknown): v is NewsRegion {
  return v === "india" || v === "world";
}

/** Below this relevance an item is stored hidden — never shown, never re-fetched. */
export const DEFAULT_MIN_RELEVANCE = 40;
