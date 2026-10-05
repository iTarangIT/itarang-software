/**
 * Dealer account health (review R-18, Requirements #5 and #41, metrics M28 /
 * M29). A dealer converts ONCE and orders many times; before this, a converted
 * dealer vanished from every report the day it converted.
 *
 * WHO (ID 41, 29 Sep 2026). Every activated dealer ACCOUNT — dealers onboarded
 * directly, with no lead behind them, included. Orders are the account's
 * invoices, matched on the account's GSTIN, non-void, drafts counted (the
 * revenue rule); while the account's GSTIN is still "PENDING" the originating
 * lead's GSTIN is used. The set and the matching live in
 * src/lib/accounts/accountList.ts, shared with Account management and the
 * Dealer accounts download, so the three cannot disagree.
 *
 * BUCKET (M28, the #5 decision; 45-day overlap resolved as Orange 31–45, Red
 * 46–60 — flagged "confirm" in the review):
 *   ordered at least once, by days since the LAST invoice:
 *     Active 0–20 · Cooling 21–30 · Orange 31–45 · Red 46–60 · Dormant 60+
 *   never ordered, by days since activation:
 *     Not ordered yet 0–30 · Never ordered 31+
 *
 * REORDER RATE (M29) over the last 30 days: dealers with ≥1 invoice in the
 * window AND ≥1 before it ÷ dealers with ≥1 invoice before it.
 *
 * Calendar days in IST. The SPOC is the ACCOUNT OWNER.
 */
import { listAccounts } from "@/lib/accounts/accountList";

import { ACCOUNT_BUCKETS, type AccountBucket } from "@/lib/dealers/accountHealthRules";

export { ACCOUNT_BUCKETS, ACCOUNT_BUCKET_LABELS, accountBucket, type AccountBucket } from "@/lib/dealers/accountHealthRules";

export type DealerHealthRow = {
    account_id: string;
    /** The lead the dealer came through; null for a direct onboarding. */
    lead_id: string | null;
    dealer: string;
    gstin: string | null;
    /** No GSTIN and no lead: invoices cannot be matched, so the bucket is a guess. */
    invoices_unmatchable: boolean;
    city: string | null;
    state: string | null;
    business_type: string | null;
    owner_id: string | null;
    owner_name: string | null;
    /** The day the account was activated (admin approval). */
    converted_on: string | null;
    first_order: string | null;
    last_order: string | null;
    days_since_last_order: number | null;
    days_since_conversion: number | null;
    orders: number;
    revenue_90d: number;
    revenue_lifetime: number;
    avg_reorder_days: number | null;
    ordered_last_30d: boolean;
    ordered_before_30d: boolean;
    bucket: AccountBucket;
};

export async function listDealerHealth(): Promise<DealerHealthRow[]> {
    const accounts = await listAccounts();
    return accounts.map((a) => ({
        account_id: a.account_id,
        lead_id: a.lead_id,
        dealer: a.dealer,
        gstin: a.gstin_missing ? null : a.gstin,
        invoices_unmatchable: a.invoices_unmatchable,
        city: a.city,
        state: a.state,
        business_type: a.business_type,
        owner_id: a.owner_id,
        owner_name: a.owner_name,
        converted_on: a.activated_on,
        first_order: a.first_order,
        last_order: a.last_order,
        days_since_last_order: a.days_since_last_order,
        days_since_conversion: a.days_since_activation,
        orders: a.orders,
        revenue_90d: a.revenue_90d,
        revenue_lifetime: a.revenue_lifetime,
        avg_reorder_days: a.avg_reorder_days,
        ordered_last_30d: a.ordered_last_30d,
        ordered_before_30d: a.ordered_before_30d,
        bucket: a.bucket,
    }));
}

export type DealerHealthGroup = {
    group: string;
    dealers: number;
    by_bucket: Record<AccountBucket, number>;
    reorder_rate: number | null;
    revenue_90d: number;
    at_risk_90d: number;
};

/**
 * Section C — summary per account owner / city / business type. Reorder rate
 * (M29) over the last 30 days against everything before them; "₹ at risk" is
 * the last-90-day revenue of dealers now Red or Dormant.
 */
export async function summarizeDealerHealth(by: "owner" | "city" | "business_type"): Promise<DealerHealthGroup[]> {
    const rows = await listDealerHealth();

    const keyOf = (r: DealerHealthRow) =>
        by === "owner"
            ? (r.owner_name ?? "(no owner)")
            : by === "city"
              ? (r.city?.trim() || "Unknown city")
              : (r.business_type ?? "Not set");

    const groups = new Map<string, DealerHealthGroup & { _before: number; _both: number }>();
    for (const r of rows) {
        const k = keyOf(r);
        const g =
            groups.get(k) ??
            {
                group: k,
                dealers: 0,
                by_bucket: Object.fromEntries(ACCOUNT_BUCKETS.map((b) => [b, 0])) as Record<AccountBucket, number>,
                reorder_rate: null,
                revenue_90d: 0,
                at_risk_90d: 0,
                _before: 0,
                _both: 0,
            };
        g.dealers += 1;
        g.by_bucket[r.bucket] += 1;
        g.revenue_90d += r.revenue_90d;
        if (r.bucket === "red" || r.bucket === "dormant") g.at_risk_90d += r.revenue_90d;
        if (r.ordered_before_30d) {
            g._before += 1;
            if (r.ordered_last_30d) g._both += 1;
        }
        groups.set(k, g);
    }
    return [...groups.values()]
        .map(({ _before, _both, ...g }) => ({ ...g, reorder_rate: _before > 0 ? _both / _before : null }))
        .sort((a, b) => b.dealers - a.dealers || a.group.localeCompare(b.group));
}
