// ID 200 #1 — the invoices Accounts Receivable counts for one dealer, exactly
// as /ceo/receivables lists them (listReceivables + the page's search).
// Read-only.
//
//   node --import tsx --env-file=.env.production scripts/receivables-for-dealer.ts "Ayansh"

import { listReceivables, matchesReceivableSearch, netOwed, receivableFileNote, receivableSourceLabel } from "@/lib/dashboard/receivables";

async function main() {
    const q = process.argv.slice(2).join(" ").trim();
    if (!q) throw new Error('usage: scripts/receivables-for-dealer.ts "<dealer name, GSTIN or invoice number>"');
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  · search "${q}"`);
    const rows = (await listReceivables()).filter((r) => matchesReceivableSearch(r, q));
    console.log("number | date | total | counted as owed | source | file | dealer / customer");
    for (const r of rows.sort((a, b) => (a.invoice_date ?? "").localeCompare(b.invoice_date ?? ""))) {
        console.log(
            [
                r.invoice_number ?? "(no number)",
                r.invoice_date?.slice(0, 10) ?? "—",
                r.total.toFixed(2),
                r.balance.toFixed(2),
                receivableSourceLabel(r),
                receivableFileNote(r) ?? "yes",
                r.dealer_name ?? `not linked (${r.customer_name ?? "?"})`,
            ].join(" | "),
        );
    }
    const invoices = rows.filter((r) => r.source !== "credit").length;
    console.log(`${invoices} invoice(s), ${rows.length - invoices} credit note(s); net receivable ₹${netOwed(rows).toFixed(2)}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
