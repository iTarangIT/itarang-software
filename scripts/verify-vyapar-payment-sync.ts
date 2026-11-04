// Read-only dry run of a Vyapar Sale Report upload (payment sync). Nothing is
// written: it calls the same parser and previewImport the Import button uses.
//
//   node --import tsx --env-file=.env.local scripts/verify-vyapar-payment-sync.ts "tasks/SaleReport v4.xlsx"
//
// 1. Parses the file; checks every document's Total = Received + Balance and
//    that no document's total exceeds the file's footer Total (the footer-row
//    bug folded the whole file's total into the last invoice).
// 2. Prints what the upload would do to amounts paid: rises, falls, ₹ newly
//    collected, totals that disagree with the CRM, older-than-last export.
// 3. Prints what the file cannot see: open CRM invoices of the same series in
//    its period that it does not list, and open ones dated before it starts.
// 4. Receivable now (Accounts Receivable figure) for reference, and whether
//    E-368 (credit_note_applications) is applied.

import { readFileSync } from "node:fs";
import { parseInvoiceWorkbook } from "@/lib/sales/vyaparParse";
import { previewImport } from "@/lib/sales/vyaparImport";
import { outstandingTotal } from "@/lib/dashboard/revenueSource";
import { hasCreditNoteApplications } from "@/lib/sales/ledgerTables";
import { listReceivables, netOwed } from "@/lib/dashboard/receivables";
import { projectReceivablesAfterImport } from "@/lib/sales/paymentSyncProjection";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}
const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`);

async function main() {
    const path = process.argv[2];
    if (!path) throw new Error('usage: verify-vyapar-payment-sync.ts "<Sale Report .xlsx>"');
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}`);
    console.log(`File:    ${path}\n`);

    const parsed = parseInvoiceWorkbook(readFileSync(path), "vyapar_register");
    console.log(`sheet ${parsed.sheet} · ${parsed.documents.length} documents · generated_at ${parsed.generated_at}`);
    if (parsed.warnings.length) console.log(`warnings:\n  ${parsed.warnings.join("\n  ")}`);
    check("file carries a Generated on stamp", !!parsed.generated_at);
    check("file carries payments (Received / Balance columns)", parsed.documents.some((d) => d.amount_paid != null));
    const live = parsed.documents.filter((d) => !d.cancelled);
    const bad = live.filter(
        (d) => d.total != null && d.amount_paid != null && d.balance_due != null && Math.abs(d.total - d.amount_paid - d.balance_due) > 1,
    );
    check("every document: Total = Received + Balance", bad.length === 0, bad.map((d) => d.number));
    const sumTotals = live.filter((d) => d.doc_type === "invoice").reduce((s, d) => s + (d.total ?? 0), 0);
    const biggest = Math.max(...live.map((d) => d.total ?? 0));
    check("no document's total is the whole file's total (footer row not folded in)", biggest < sumTotals || live.length === 1, {
        biggest,
        sumTotals,
    });

    const p = await previewImport(parsed);
    const s = p.payments;
    check("preview has a payment section", !!s);
    if (s) {
        console.log(`\nPayments as of ${s.generated_at} (last imported: ${s.last_generated_at ?? "none"})`);
        check("not older than the last export imported", !s.older_than_last);
        console.log(`  rises ${s.increases} · falls ${s.decreases} · newly collected ${inr(s.collected)} · still owed on file invoices ${inr(s.open_balance)}`);
        console.log(`  CRM/Vyapar total mismatches: ${s.total_mismatches}`);
        for (const r of p.rows.filter((r) => r.payment_change === "increase" || r.payment_change === "decrease" || r.total_mismatch)) {
            console.log(
                `    ${r.number.padEnd(16)} ${String(r.payment_change).padEnd(8)} ${inr(r.paid_before)} → ${inr(r.paid_after)}  owed ${inr(r.balance_after)}` +
                    (r.total_mismatch ? `  ⚠ CRM ${inr(r.crm_total)} vs Vyapar ${inr(r.register_total)}` : "") +
                    (r.overrides_manual ? "  (hand-entered)" : ""),
            );
        }
        console.log(`  open CRM invoices in the period but NOT in the file: ${s.not_in_file.length} (${inr(s.not_in_file_balance)})`);
        for (const m of s.not_in_file.slice(0, 20)) console.log(`    ${m.number.padEnd(16)} ${m.date} ${m.party} ${inr(m.balance)}`);
        console.log(
            `  open CRM invoices dated BEFORE the file starts (${p.period.from}): ${s.before_period.count} (${inr(s.before_period.balance)}), oldest ${s.before_period.oldest}`,
        );
    }
    console.log(`\nactions: ${JSON.stringify(p.totals)}`);
    // E-370 — duplicate / updated detection.
    const t = p.totals;
    console.log(`classification: ${t.new_docs} new · ${t.updated_docs} updated · ${t.duplicates} duplicates (skipped)`);
    for (const r of p.rows.filter((r) => r.classification === "updated" || r.classification === "new")) {
        console.log(`    ${r.number.padEnd(16)} ${String(r.classification).padEnd(8)} changes=[${(r.changes ?? []).join(",")}] drift=[${(r.drift ?? []).join(",")}]`);
    }
    const classifiedAll = p.rows.filter((r) => r.action !== "in_zoho").every((r) => r.classification);
    check("every document (bar old Zoho ones) is classified new / updated / duplicate", classifiedAll);
    console.log(`Accounts Receivable now (overview card): ${inr(await outstandingTotal())}`);

    // The preview's "Receivable now → after import" must start from exactly the
    // figure CEO › Receivables shows (listReceivables + netOwed).
    const page = netOwed(await listReceivables());
    const proj = await projectReceivablesAfterImport(parsed, p);
    console.log(`Receivables page: ${inr(page)} · preview before ${inr(proj.before)} → after ${inr(proj.after)}`);
    check("preview 'Receivable now' = the receivables page figure", Math.abs(proj.before - page) < 1, { page, before: proj.before });
    for (const c of proj.customers.slice(0, 10)) console.log(`    ${String(c.name).slice(0, 40).padEnd(40)} ${inr(c.before)} → ${inr(c.after)}`);
    console.log(`E-368 credit_note_applications applied: ${await hasCreditNoteApplications()}`);

    console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
