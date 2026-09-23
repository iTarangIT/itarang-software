/**
 * Data health (review R-24, CEO dashboard row 6): how much of each headline
 * number is unreliable, so every other figure on the page can be read with the
 * right amount of trust. Each check is a count over a denominator, and each
 * links to where it gets fixed. The goal for every one of them is 0 %.
 *
 *   calls_unattributed   NeoDove / rep calls with no performer, last 30 days
 *                        (R-03 — link the NeoDove agent)
 *   leads_no_city        active leads with a blank city (R-20)
 *   leads_no_type        active leads with no business type (R-19)
 *   converted_no_gstin   converted leads with no GSTIN — their invoices
 *                        cannot be linked (R-11)
 *   lines_no_weight      buyback lines on submitted requests with no weight —
 *                        kg is under-counted (R-13)
 *   invoices_unmatched   invoices not linked to a CRM dealer (R-11)
 *
 * Each check runs on its own and reports `null` on failure (e.g. a table
 * absent on one environment) — one broken check must not blank the panel.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { revenueSummary } from "@/lib/dashboard/revenueSource";

export type DataHealthCheck = {
    key: string;
    label: string;
    bad: number | null;
    total: number | null;
    pct: number | null;
    fix_href: string;
    fix_label: string;
};

async function ratio(q: SQL): Promise<{ bad: number; total: number } | null> {
    try {
        const r = (await db.execute(q)) as unknown as Array<{ bad: string; total: string }>;
        return { bad: Number(r[0]?.bad ?? 0), total: Number(r[0]?.total ?? 0) };
    } catch (e) {
        console.warn("[dataHealth] check failed", e instanceof Error ? e.message : e);
        return null;
    }
}

export async function dataHealth(): Promise<DataHealthCheck[]> {
    const [calls, city, type, gstin, weight, invoices] = await Promise.all([
        ratio(sql`
            SELECT COUNT(*) FILTER (WHERE performed_by IS NULL) AS bad, COUNT(*) AS total
              FROM lead_touchpoints
             WHERE touchpoint_type = 'inside_sales_call'
               AND performed_at >= now() - INTERVAL '30 days'
        `),
        ratio(sql`
            SELECT COUNT(*) FILTER (WHERE NULLIF(btrim(city), '') IS NULL) AS bad, COUNT(*) AS total
              FROM dealer_leads WHERE is_active IS NOT FALSE
        `),
        ratio(sql`
            SELECT COUNT(*) FILTER (WHERE business_type IS NULL) AS bad, COUNT(*) AS total
              FROM dealer_leads WHERE is_active IS NOT FALSE
        `),
        ratio(sql`
            SELECT COUNT(*) FILTER (WHERE NULLIF(btrim(gstin), '') IS NULL) AS bad, COUNT(*) AS total
              FROM dealer_leads WHERE lead_status = 'Converted' AND is_active IS NOT FALSE
        `),
        ratio(sql`
            SELECT COUNT(*) FILTER (WHERE COALESCE(l.unit_weight_kg, 0) <= 0) AS bad, COUNT(*) AS total
              FROM buyback_lines l
              JOIN buyback_batches b ON b.id = l.batch_id
              JOIN buyback_requests r ON r.id = b.request_id
             WHERE r.submitted_at IS NOT NULL
        `),
        revenueSummary({ from: "2000-01-01", to: "2999-12-31" })
            .then((s) => ({ bad: s.unlinked_count, total: s.count }))
            .catch(() => null),
    ]);

    const make = (
        key: string,
        label: string,
        r: { bad: number; total: number } | null,
        fix_href: string,
        fix_label: string,
    ): DataHealthCheck => ({
        key,
        label,
        bad: r?.bad ?? null,
        total: r?.total ?? null,
        pct: r && r.total > 0 ? Math.round((r.bad / r.total) * 1000) / 10 : r ? 0 : null,
        fix_href,
        fix_label,
    });

    return [
        make("calls_unattributed", "Calls credited to no one (30 d)", calls, "/leads/neodove-campaigns/agents", "Link NeoDove agents"),
        make("leads_no_city", "Leads with no city", city, "/leads", "Leads list"),
        make("leads_no_type", "Leads with no business type", type, "/leads", "Leads list → “Not set” chip"),
        make("converted_no_gstin", "Converted dealers with no GSTIN", gstin, "/admin/reports/dealer-health", "Dealer Health"),
        make("lines_no_weight", "Buyback lines with no weight", weight, "/admin/buyback", "Buyback queue"),
        make("invoices_unmatched", "Invoices not linked to a dealer", invoices, "/ceo/invoices", "Sales Invoices"),
    ];
}
