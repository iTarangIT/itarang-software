// B10 — read-only check of the funnel counts builder against the live DB.
//
//   node --import tsx --env-file=.env.local scripts/verify-funnel-counts.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//
// Asserts the three definition-of-done identities:
//   1. totals (group_by=none) == Σ rows (group_by=city), for every count
//   2. files_rejected == Σ rejection_reasons
//   3. filtering by one NBFC changes ONLY files_disbursed / files_rejected
//   4. the four headline numbers == independent hand SQL on the base tables
// and prints the totals, the by-city rows and the reasons so they can be
// eyeballed against SQL. Exits 1 on any mismatch.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildFunnelCounts, type FunnelCounts } from "@/lib/admin/funnelCounts";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const line = (s = "") => console.log(s);
const KEYS: (keyof FunnelCounts)[] = [
    "dealers_onboarded",
    "kyc_shared",
    "files_disbursed",
    "files_rejected",
    "onboarding_rejected",
];

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    line(`DB host: ${host}`);
    // Default: a wide window, since sandbox activity is spread over months.
    const from = arg("from") ?? "2026-01-01";
    const to = arg("to");
    let failed = false;

    const none = await buildFunnelCounts({ from, to, group_by: "none" });
    line(`range ${none.filters.from} → ${none.filters.to}`);
    line(`totals: ${JSON.stringify(none.totals)}`);

    // 1. totals == Σ by city
    const byCity = await buildFunnelCounts({ from, to, group_by: "city" });
    line(`by city: ${byCity.rows.length} rows`);
    for (const r of byCity.rows.slice(0, 8)) {
        line(`   ${r.label.padEnd(22)} onb=${r.dealers_onboarded} kyc=${r.kyc_shared} dis=${r.files_disbursed} rej=${r.files_rejected} onbRej=${r.onboarding_rejected}`);
    }
    for (const k of KEYS) {
        const sum = byCity.rows.reduce((a, r) => a + r[k], 0);
        const ok = sum === none.totals[k];
        line(`   Σ city ${k} = ${sum} vs total ${none.totals[k]}  ${ok ? "OK" : "MISMATCH"}`);
        if (!ok) failed = true;
    }

    // 2. rejected == Σ reasons
    const reasonSum = none.rejection_reasons.reduce((a, r) => a + r.count, 0);
    line(`reasons: ${JSON.stringify(none.rejection_reasons)}`);
    line(`   Σ reasons = ${reasonSum} vs files_rejected ${none.totals.files_rejected}  ${reasonSum === none.totals.files_rejected ? "OK" : "MISMATCH"}`);
    if (reasonSum !== none.totals.files_rejected) failed = true;

    // 3. NBFC filter touches only the loan counts
    const nbfc = none.options.nbfcs[0];
    if (!nbfc) {
        line("no NBFC tenant to filter by — skipping check 3");
    } else {
        const one = await buildFunnelCounts({ from, to, group_by: "none", nbfc_id: nbfc.id });
        line(`filtered to ${nbfc.name}: ${JSON.stringify(one.totals)}`);
        const untouched = one.totals.dealers_onboarded === none.totals.dealers_onboarded
            && one.totals.kyc_shared === none.totals.kyc_shared
            && one.totals.onboarding_rejected === none.totals.onboarding_rejected;
        const narrowed = one.totals.files_disbursed <= none.totals.files_disbursed
            && one.totals.files_rejected <= none.totals.files_rejected;
        line(`   onboarding/KYC unchanged: ${untouched ? "OK" : "MISMATCH"} | disbursed/rejected narrowed or equal: ${narrowed ? "OK" : "MISMATCH"}`);
        line(`   note shown: ${one.notes[0]}`);
        if (!untouched || !narrowed) failed = true;
    }

    // Bonus: the other group-bys run and also sum to the totals.
    for (const g of ["state", "month", "dealer", "nbfc"] as const) {
        const r = await buildFunnelCounts({ from, to, group_by: g });
        const bad = KEYS.filter((k) => r.rows.reduce((a, x) => a + x[k], 0) !== none.totals[k]);
        line(`by ${g}: ${r.rows.length} rows  ${bad.length ? "MISMATCH on " + bad.join(", ") : "sums OK"}`);
        if (bad.length) failed = true;
    }

    // 4. The four headline numbers against INDEPENDENT hand SQL (ID 12) — plain
    //    counts on the base tables, no joins, dates cast to the IST day. This is
    //    what finance can re-run for one week (--from / --to) and compare by
    //    hand; it also catches a join in the builder that multiplies rows.
    const lo = none.filters.from;
    const hi = none.filters.to;
    const istDay = (col: ReturnType<typeof sql>) => sql`(${col} AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${lo}::date AND ${hi}::date`;
    const one = async (q: ReturnType<typeof sql>) =>
        Number(((await db.execute(q)) as unknown as Array<{ n: string }>)[0]?.n ?? 0);
    const hand = {
        // approved_at / rejected_at are NAIVE timestamps holding UTC wall-clock.
        dealers_onboarded: await one(sql`
            SELECT COUNT(*)::text AS n FROM dealer_onboarding_applications
             WHERE approved_at IS NOT NULL AND ${istDay(sql`(approved_at AT TIME ZONE 'UTC')`)}`),
        kyc_shared: await one(sql`
            SELECT COUNT(*)::text AS n
              FROM (SELECT lead_id, MIN(created_at) AS first_at FROM admin_verification_queue GROUP BY lead_id) q
             WHERE ${istDay(sql`q.first_at`)}`),
        files_disbursed: await one(sql`
            SELECT COUNT(*)::text AS n FROM loan_sanctions
             WHERE disbursed_at IS NOT NULL AND ${istDay(sql`disbursed_at`)}`),
        files_rejected: await one(sql`
            SELECT COUNT(*)::text AS n FROM loan_sanctions
             WHERE lower(status) = 'rejected' AND ${istDay(sql`COALESCE(updated_at, created_at)`)}`),
    };
    line(`hand SQL ${lo} → ${hi}: ${JSON.stringify(hand)}`);
    for (const k of Object.keys(hand) as (keyof typeof hand)[]) {
        const ok = hand[k] === none.totals[k];
        line(`   ${k}: builder ${none.totals[k]} vs hand ${hand[k]}  ${ok ? "MATCH" : "MISMATCH"}`);
        if (!ok) failed = true;
    }

    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
