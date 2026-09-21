/**
 * Pure account-health rules (review R-18, metric M28) — no I/O, so they are
 * unit-tested and importable from client components. The data half is
 * ./accountHealth.ts.
 */

export const ACCOUNT_BUCKETS = [
    "active",
    "cooling",
    "orange",
    "red",
    "dormant",
    "not_ordered_yet",
    "never_ordered",
] as const;
export type AccountBucket = (typeof ACCOUNT_BUCKETS)[number];

export const ACCOUNT_BUCKET_LABELS: Record<AccountBucket, string> = {
    active: "Active (0–20 d)",
    cooling: "Cooling (21–30 d)",
    orange: "Orange — pitch now (31–45 d)",
    red: "Red — billing must happen (46–60 d)",
    dormant: "Dormant (60+ d)",
    not_ordered_yet: "Not ordered yet (≤30 d since conversion)",
    never_ordered: "Never ordered (31+ d since conversion)",
};

/** Pure bucket rule — the SQL below mirrors it; tested in __tests__. */
export function accountBucket(
    daysSinceLastOrder: number | null,
    daysSinceConversion: number | null,
): AccountBucket {
    if (daysSinceLastOrder == null) {
        return (daysSinceConversion ?? 0) <= 30 ? "not_ordered_yet" : "never_ordered";
    }
    if (daysSinceLastOrder <= 20) return "active";
    if (daysSinceLastOrder <= 30) return "cooling";
    if (daysSinceLastOrder <= 45) return "orange";
    if (daysSinceLastOrder <= 60) return "red";
    return "dormant";
}
