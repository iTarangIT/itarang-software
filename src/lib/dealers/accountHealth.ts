/**
 * Dealer account health (review R-18, Requirements #5 and #41, metrics M28 /
 * M29). A dealer converts ONCE and orders many times; before this, a converted
 * dealer vanished from every report the day it converted.
 *
 * WHO. Every lead with lead_status = 'Converted'. Orders are its invoices —
 * matched on GSTIN through revenueSource's matchedUnion() (R-11), non-void,
 * drafts counted, exactly the revenue rule. No GSTIN on the lead = no orders
 * can be seen, and the dealer reads "Never ordered" until one is added.
 *
 * BUCKET (M28, the #5 decision; 45-day overlap resolved as Orange 31–45, Red
 * 46–60 — flagged "confirm" in the review):
 *   ordered at least once, by days since the LAST invoice:
 *     Active 0–20 · Cooling 21–30 · Orange 31–45 · Red 46–60 · Dormant 60+
 *   never ordered, by days since conversion:
 *     Not ordered yet 0–30 · Never ordered 31+
 *
 * REORDER RATE (M29) over a window: dealers with ≥1 invoice in the window AND
 * ≥1 before it ÷ dealers with ≥1 invoice before it.
 *
 * Calendar days in IST. The SPOC is the lead's current owner.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";

import {
    ACCOUNT_BUCKETS,
    accountBucket,
    type AccountBucket,
} from "@/lib/dealers/accountHealthRules";

export { ACCOUNT_BUCKETS, ACCOUNT_BUCKET_LABELS, accountBucket, type AccountBucket } from "@/lib/dealers/accountHealthRules";

export type DealerHealthRow = {
    lead_id: string;
    dealer: string;
    gstin: string | null;
    city: string | null;
    state: string | null;
    business_type: string | null;
    owner_id: string | null;
    owner_name: string | null;
    converted_on: string | null;
    first_order: string | null;
    last_order: string | null;
    days_since_last_order: number | null;
    days_since_conversion: number | null;
    orders: number;
    revenue_90d: number;
    revenue_lifetime: number;
    avg_reorder_days: number | null;
    bucket: AccountBucket;
};

export async function listDealerHealth(): Promise<DealerHealthRow[]> {
    const invoices = await matchedUnion();
    const rows = await db.execute(sql`
        WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
        orders AS (
            SELECT r.dealer_lead_id,
                   COUNT(*)                          AS n,
                   MIN(r.invoice_date)               AS first_order,
                   MAX(r.invoice_date)               AS last_order,
                   COALESCE(SUM(r.total), 0)         AS lifetime,
                   COALESCE(SUM(r.total) FILTER (
                       WHERE r.invoice_date > (SELECT d FROM today) - 90), 0) AS last_90d,
                   COUNT(DISTINCT r.invoice_date)    AS order_days
              FROM ${invoices} AS r
             WHERE r.dealer_lead_id IS NOT NULL AND ${REVENUE_NOT_VOID}
             GROUP BY r.dealer_lead_id
        )
        SELECT dl.id                                                AS lead_id,
               COALESCE(dl.shop_name, dl.dealer_name, '(unnamed)')  AS dealer,
               dl.gstin, dl.city, dl.state,
               to_jsonb(dl) ->> 'business_type'                     AS business_type,
               dl.current_owner_id                                  AS owner_id,
               u.name                                               AS owner_name,
               (dl.closed_at AT TIME ZONE 'Asia/Kolkata')::date     AS converted_on,
               o.first_order, o.last_order,
               ((SELECT d FROM today) - o.last_order)               AS days_since_last_order,
               ((SELECT d FROM today) - (dl.closed_at AT TIME ZONE 'Asia/Kolkata')::date) AS days_since_conversion,
               COALESCE(o.n, 0)                                     AS orders,
               COALESCE(o.last_90d, 0)                              AS revenue_90d,
               COALESCE(o.lifetime, 0)                              AS revenue_lifetime,
               CASE WHEN o.order_days > 1
                    THEN ROUND((o.last_order - o.first_order)::numeric / (o.order_days - 1), 1)
               END                                                  AS avg_reorder_days
          FROM dealer_leads dl
          LEFT JOIN orders o ON o.dealer_lead_id = dl.id
          LEFT JOIN users u  ON u.id::text = dl.current_owner_id
         WHERE dl.lead_status = 'Converted'
           AND dl.is_active IS NOT FALSE
         ORDER BY days_since_last_order DESC NULLS FIRST, dealer
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => {
        const sinceOrder = r.days_since_last_order == null ? null : Number(r.days_since_last_order);
        const sinceConv = r.days_since_conversion == null ? null : Number(r.days_since_conversion);
        return {
            lead_id: String(r.lead_id),
            dealer: String(r.dealer),
            gstin: (r.gstin as string | null) ?? null,
            city: (r.city as string | null) ?? null,
            state: (r.state as string | null) ?? null,
            business_type: (r.business_type as string | null) ?? null,
            owner_id: (r.owner_id as string | null) ?? null,
            owner_name: (r.owner_name as string | null) ?? null,
            converted_on: r.converted_on ? String(r.converted_on).slice(0, 10) : null,
            first_order: r.first_order ? String(r.first_order).slice(0, 10) : null,
            last_order: r.last_order ? String(r.last_order).slice(0, 10) : null,
            days_since_last_order: sinceOrder,
            days_since_conversion: sinceConv,
            orders: Number(r.orders ?? 0),
            revenue_90d: Number(r.revenue_90d ?? 0),
            revenue_lifetime: Number(r.revenue_lifetime ?? 0),
            avg_reorder_days: r.avg_reorder_days == null ? null : Number(r.avg_reorder_days),
            bucket: accountBucket(sinceOrder, sinceConv),
        };
    });
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
 * Section C — summary per SPOC / city / business type. Reorder rate (M29)
 * over the last `windowDays` against everything before it; "₹ at risk" is the
 * last-90-day revenue of dealers now Red or Dormant.
 */
export async function summarizeDealerHealth(
    by: "owner" | "city" | "business_type",
    windowDays = 30,
): Promise<DealerHealthGroup[]> {
    const invoices = await matchedUnion();
    const rows = await listDealerHealth();
    const reorder = (await db.execute(sql`
        WITH w AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date - ${windowDays}::int AS start)
        SELECT r.dealer_lead_id,
               bool_or(r.invoice_date <  (SELECT start FROM w)) AS before,
               bool_or(r.invoice_date >= (SELECT start FROM w)) AS within
          FROM ${invoices} AS r
         WHERE r.dealer_lead_id IS NOT NULL AND ${REVENUE_NOT_VOID}
         GROUP BY r.dealer_lead_id
    `)) as unknown as Array<{ dealer_lead_id: string; before: boolean; within: boolean }>;
    const re = new Map(reorder.map((x) => [x.dealer_lead_id, x]));

    const keyOf = (r: DealerHealthRow) =>
        by === "owner"
            ? (r.owner_name ?? "(unassigned)")
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
        const x = re.get(r.lead_id);
        if (x?.before) {
            g._before += 1;
            if (x.within) g._both += 1;
        }
        groups.set(k, g);
    }
    return [...groups.values()]
        .map(({ _before, _both, ...g }) => ({ ...g, reorder_rate: _before > 0 ? _both / _before : null }))
        .sort((a, b) => b.dealers - a.dealers || a.group.localeCompare(b.group));
}
