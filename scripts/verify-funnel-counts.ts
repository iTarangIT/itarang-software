// B10 — read-only check of the funnel counts builder against the live DB.
//
//   node --import tsx --env-file=.env.local scripts/verify-funnel-counts.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//
// Asserts the three definition-of-done identities:
//   1. totals (group_by=none) == Σ rows (group_by=city), for every count
//   2. files_rejected == Σ rejection_reasons
//   3. filtering by one NBFC changes ONLY files_disbursed / files_rejected
// and prints the totals, the by-city rows and the reasons so they can be
// eyeballed against SQL. Exits 1 on any mismatch.

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

    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
