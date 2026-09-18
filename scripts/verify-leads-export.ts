// B11 — read-only check of the full leads export against the live DB.
//
//   node --import tsx --env-file=.env.local scripts/verify-leads-export.ts
//
// 1. Times the export query over EVERY lead (the 5,000-lead / 15 s target).
// 2. Cross-checks Business till date and Last billing date for one lead that
//    has matched invoices against independent SQL.
// 3. Confirms a lead with no visits/calls/billing has NULLs, not zeros/strings.
// 4. Confirms "visits before first billing" against an independent count.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { countLeadsForExport, fetchLeadsForExport } from "@/lib/admin/leadsExport";
import { NO_CAPABILITIES } from "@/lib/leads/access";
import { parseLeadListFilters } from "@/lib/leads/leadListParams";

const line = (s = "") => console.log(s);

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    line(`DB host: ${host}`);
    let failed = false;

    const filters = await parseLeadListFilters(new URLSearchParams(), NO_CAPABILITIES);
    const total = await countLeadsForExport(filters);
    const t0 = Date.now();
    const rows = await fetchLeadsForExport(filters);
    const ms = Date.now() - t0;
    line(`all leads: ${total} matched, ${rows.length} rows in ${ms} ms ${ms < 15000 ? "(under 15 s)" : "(OVER 15 s)"}`);
    if (ms >= 15000) failed = true;

    const withBilling = rows.filter((r) => r.billing_match === "name");
    const withVisits = rows.filter((r) => r.last_visit_date);
    const withCalls = rows.filter((r) => r.last_call_at);
    line(`rows with billing match: ${withBilling.length} | with a visit: ${withVisits.length} | with a call: ${withCalls.length}`);

    // 2. billing cross-check on one lead
    const pick = withBilling[0];
    if (!pick) {
        line("no lead matched an invoice by name — billing cross-check skipped");
    } else {
        const hand = (await db.execute<{ total: string; last: string; first: string; visits: number }>(sql`
            WITH inv AS (
                SELECT lower(trim(customer_name)) k, invoice_number, invoice_date::date d, total::numeric t FROM sales_invoices WHERE invoice_date IS NOT NULL
                UNION ALL
                SELECT lower(trim(z.customer_name)), z.invoice_number, z.invoice_date::date, z.total::numeric FROM zoho_invoices z
                 WHERE z.invoice_date IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales_invoices s WHERE s.invoice_number = z.invoice_number)
            ), m AS (
                SELECT i.* FROM inv i, dealer_leads dl
                 WHERE dl.id = ${pick.lead_id} AND i.k IN (lower(trim(dl.dealer_name)), lower(trim(dl.shop_name)))
            )
            SELECT SUM(t)::text AS total, MAX(d)::text AS last, MIN(d)::text AS first,
                   (SELECT COUNT(*)::int FROM lead_visits v WHERE v.dealer_lead_id = ${pick.lead_id}
                      AND v.actual_visit_date IS NOT NULL AND v.actual_visit_date < (SELECT MIN(d) FROM m)) AS visits
              FROM m
        `)) as unknown as { total: string; last: string; first: string; visits: number }[];
        const h = hand[0]!;
        const okTotal = Number(h.total) === Number(pick.business_till_date);
        const okLast = h.last === pick.last_billing_date;
        const okVisits = Number(h.visits) === Number(pick.visits_before_first_billing);
        line(`billing cross-check for ${pick.dealer_name ?? pick.shop_name} (${pick.lead_id}):`);
        line(`   export: total=${pick.business_till_date} last=${pick.last_billing_date} visitsBefore=${pick.visits_before_first_billing}`);
        line(`   SQL:    total=${h.total} last=${h.last} visitsBefore=${h.visits}`);
        line(`   ${okTotal && okLast && okVisits ? "MATCH" : "MISMATCH"}`);
        if (!(okTotal && okLast && okVisits)) failed = true;
    }

    // 3. blanks stay blank
    const bare = rows.find((r) => !r.last_visit_date && !r.last_call_at && r.billing_match === "none");
    if (bare) {
        const blanks = [bare.last_visit_date, bare.next_visit_date, bare.last_call_at, bare.next_call_at, bare.business_till_date, bare.last_billing_date, bare.visits_before_first_billing];
        const ok = blanks.every((v) => v === null);
        line(`lead with nothing logged (${bare.lead_id}): all seven derived cells NULL → ${ok ? "OK" : "NOT NULL: " + JSON.stringify(blanks)}`);
        if (!ok) failed = true;
    }

    // Sample rows
    line();
    line("sample rows with a visit:");
    for (const r of withVisits.slice(0, 3)) {
        line(`   ${(r.dealer_name ?? r.shop_name ?? "").padEnd(26)} POC=${r.owner_name ?? "-"} lastVisit=${r.last_visit_date} nextVisit=${r.next_visit_date ?? "-"} lastCall=${r.last_call_at ?? "-"} remarks=${(r.latest_remarks ?? "").slice(0, 40)}`);
    }

    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
