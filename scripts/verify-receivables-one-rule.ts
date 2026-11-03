// ID 217 — read-only: every all-time Accounts Receivable figure is the same number.
//
//   node --import tsx --env-file=.env.local scripts/verify-receivables-one-rule.ts
//
// Compares, read together:
//   - receivablesSummary().owed — the CEO overview card, CEO metrics and the
//     Revenue & costs ageing strip (all read it since ID 217);
//   - the age buckets' sum (must equal the total);
//   - netOwed(listReceivables()) — the /ceo/receivables page header;
//   - outstandingTotal() — the old SQL sum the card used to read (reference:
//     a difference here means the two rules drifted).

import { outstandingTotal } from "@/lib/dashboard/revenueSource";
import { listReceivables, netOwed, receivablesSummary } from "@/lib/dashboard/receivables";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
let failed = 0;
function check(label: string, a: number, b: number) {
    const ok = Math.abs(a - b) < 1;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${inr(a)} vs ${inr(b)}`);
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host || "(unset)"}`);
    const [summary, rows, sqlSum] = await Promise.all([receivablesSummary(), listReceivables(), outstandingTotal()]);
    const buckets = summary.buckets.reduce((a, b) => a + b.amount, 0);
    console.log(`Accounts Receivable: ${inr(summary.owed)} across ${summary.invoices} invoices`);
    for (const b of summary.buckets) console.log(`  ${b.label.padEnd(16)} ${inr(b.amount).padStart(16)}  ${b.invoices}`);
    check("card / strip total = sum of age buckets", summary.owed, buckets);
    check("card = Accounts Receivable page header", summary.owed, netOwed(rows));
    check("card = old SQL sum (outstandingTotal)", summary.owed, sqlSum);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
