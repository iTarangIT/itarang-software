/**
 * Campaign categories (E-398). A fixed list so the Analytics groups stay clean
 * ("3W" and "3 Wheeler" can never become two rows). Add a value here to offer
 * it; the DB column is a plain varchar(24).
 */
export const LI_CATEGORIES = ["3 Wheeler", "2 Wheeler", "FinTech", "NBFC", "Dealer", "Other"] as const;
export type LiCategory = (typeof LI_CATEGORIES)[number];

/** Campaigns created before categories existed (or on a DB without E-398). */
export const UNCATEGORISED = "Uncategorised";

export function isCategory(v: unknown): v is LiCategory {
  return typeof v === "string" && (LI_CATEGORIES as readonly string[]).includes(v);
}
