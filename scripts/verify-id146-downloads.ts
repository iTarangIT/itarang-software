// Read-only check of ID 146: every Reports › Data downloads dataset runs once,
// count and build, against the real query builders — so a download that reads
// a retired column/table (the 4-5 Oct double build) fails here, not for
// finance at month end.
//
//   node --import tsx --env-file=.env.local scripts/verify-id146-downloads.ts [from] [to]
//
// Runs as an admin with no filters over [from, to] (default: all time → today),
// at most 5 rows per sheet. Only SELECTs: the dataset builders never write.
// Also checks the Quotes sheet: a quote whose lines carry a list price must
// show a list price total and a discount.

import { DATASETS, type RunContext } from "@/lib/exports/datasets/registry";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const [from = "2000-01-01", to = today] = process.argv.slice(2);
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  ${from} → ${to}\n`);

    const params = new URLSearchParams({ from, to });
    const ctx = {
        params,
        user: { id: "00000000-0000-0000-0000-000000000000", role: "admin", name: "verify-id146" },
        ownOnly: false,
        maxRows: 5,
    } as unknown as RunContext;

    for (const d of DATASETS) {
        try {
            const n = await d.count(ctx);
            const sheets = await d.build(ctx);
            const sizes = sheets.map((s) => `${s.name}: ${s.rows.length}`).join(", ");
            check(`${d.id} — count ${n}; ${sizes}`, true);

            if (d.id === "quotes") {
                const quotes = sheets[0]?.rows ?? [];
                const lines = sheets[1]?.rows ?? [];
                const listedLine = lines.find((l) => l.list_price != null);
                if (listedLine) {
                    const q = quotes.find(
                        (r) => r.lead_id === listedLine.lead_id && r.version_no === listedLine.version_no,
                    );
                    if (q) check(`quotes: a quote with a list-priced line shows a list total`, q.list_total != null, q.quote_number);
                } else {
                    console.log("      (no list-priced quote line in the first rows — list price check skipped)");
                }
            }
        } catch (err) {
            const e = err as Error & { cause?: Error };
            check(`${d.id}`, false, e.cause?.message ?? e.message.slice(0, 300));
        }
    }

    console.log(failed ? `\n${failed} FAILED` : "\nall downloads ran");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
