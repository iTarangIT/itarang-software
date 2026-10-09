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
    // ID 5 — closed by hand ("Lost / closed dealer", E-332); never Dormant.
    "closed",
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
    closed: "Closed (lost / closed dealer)",
};

/** Pure bucket rule — the SQL below mirrors it; tested in __tests__. */
export function accountBucket(
    daysSinceLastOrder: number | null,
    daysSinceConversion: number | null,
    closed = false,
): AccountBucket {
    if (closed) return "closed";
    if (daysSinceLastOrder == null) {
        return (daysSinceConversion ?? 0) <= 30 ? "not_ordered_yet" : "never_ordered";
    }
    if (daysSinceLastOrder <= 20) return "active";
    if (daysSinceLastOrder <= 30) return "cooling";
    if (daysSinceLastOrder <= 45) return "orange";
    if (daysSinceLastOrder <= 60) return "red";
    return "dormant";
}

/**
 * ID 5 — "Order placed" (E-334). A salesperson's claim pauses the ageing clock
 * for this many days from the order date; an invoice dated inside the window
 * confirms it.
 */
export const ORDER_CLAIM_WINDOW_DAYS = 15;

export type OrderClaimStatus = "pending" | "confirmed" | "unconfirmed" | "withdrawn";

export const ORDER_CLAIM_STATUS_LABELS: Record<OrderClaimStatus, string> = {
    pending: "Order placed — awaiting invoice",
    confirmed: "Confirmed by an invoice",
    unconfirmed: "Order claimed, no invoice raised",
    withdrawn: "Withdrawn",
};

/**
 * Pure claim rule — orderClaims.ts's SQL mirrors it; tested in __tests__.
 * `invoiced` = an invoice for the account dated within
 * [order_date, order_date + ORDER_CLAIM_WINDOW_DAYS].
 */
export function orderClaimStatus(args: {
    withdrawn: boolean;
    invoiced: boolean;
    daysSinceOrder: number;
}): OrderClaimStatus {
    if (args.withdrawn) return "withdrawn";
    if (args.invoiced) return "confirmed";
    return args.daysSinceOrder <= ORDER_CLAIM_WINDOW_DAYS ? "pending" : "unconfirmed";
}

/**
 * The days the bucket is worked out from. A pending claim counts as the latest
 * order (the paused clock); a confirmed claim's invoice is already in
 * `daysSinceLastInvoice`; an unconfirmed or withdrawn one counts for nothing.
 */
export function effectiveDaysSinceOrder(
    daysSinceLastInvoice: number | null,
    daysSincePendingClaim: number | null,
): number | null {
    if (daysSincePendingClaim == null) return daysSinceLastInvoice;
    if (daysSinceLastInvoice == null) return daysSincePendingClaim;
    return Math.min(daysSinceLastInvoice, daysSincePendingClaim);
}
