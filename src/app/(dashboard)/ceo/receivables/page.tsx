// What the CEO overview's "Accounts Receivable" card is made of: every invoice
// still owed, with the same rule and source the card sums. The query and the
// ageing buckets live in lib/dashboard/receivables.ts, which the ageing strip
// on "Revenue & costs" (ID 89) reads too.

import Link from "next/link";
import { ArrowLeft, FileText } from "lucide-react";

import { requireRole } from "@/lib/auth-utils";
import {
    listReceivables,
    matchesReceivableSearch,
    netOwed,
    receivableFileNote,
    receivableSourceLabel,
    RECEIVABLE_AGES as AGES,
    receivableAgeOf as ageOf,
    type ReceivableAgeKey,
    type ReceivableRow as Row,
} from "@/lib/dashboard/receivables";

// ID 166: invoice PDFs open through a fresh 15-minute link on each click.
import FreshFileLink from "@/components/shared/FreshFileLink";
import { receivablesSourceText } from "@/lib/sales/invoiceFreshnessRules";
import DebtorTable, { type Debtor } from "./_components/DebtorTable";
export const dynamic = "force-dynamic";

type AgeKey = ReceivableAgeKey | "all";


const rupees = (n: number) => `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const inr = (n: number) =>
    Math.abs(n) >= 1e7
        ? `₹${(n / 1e7).toFixed(2)} Cr`
        : Math.abs(n) >= 1e5
          ? `₹${(n / 1e5).toFixed(2)} L`
          : rupees(Math.round(n));
const fmtDate = (d: string) =>
    new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    });

export default async function CeoReceivablesPage({
    searchParams,
}: {
    searchParams: Promise<{ age?: string; q?: string }>;
}) {
    await requireRole(["ceo", "admin"]);
    const sp = await searchParams;
    const validAges: string[] = ["all", "no_date", ...AGES.map((a) => a.key)];
    const age: AgeKey = validAges.includes(sp.age ?? "") ? (sp.age as AgeKey) : "all";

    const q = (sp.q ?? "").trim().slice(0, 100);

    const [rows, freshness] = await Promise.all([
        listReceivables(),
        import("@/lib/sales/invoiceFreshness").then((m) => m.invoiceFreshness()).catch(() => null),
    ]);

    const sum = (xs: Row[]) => xs.reduce((a, r) => a + r.balance, 0);
    const owed = netOwed(rows);
    const credits = rows.filter((r) => r.source === "credit");
    const overdue = rows.filter((r) => r.overdue_days != null && r.overdue_days > 0);
    const unlinked = rows.filter((r) => r.account_id == null && r.dealer_lead_id == null);
    const byAge = AGES.map((a) => ({ ...a, rows: rows.filter((r) => ageOf(r) === a.key) }));
    const noDate = rows.filter((r) => ageOf(r) === "no_date");
    // ID 200: the search narrows the invoice list and the customers alike.
    const found = q ? rows.filter((r) => matchesReceivableSearch(r, q)) : rows;
    const shown = age === "all" ? found : found.filter((r) => ageOf(r) === age);

    // Who owes the most — the list a collections call starts from.
    // Each customer keeps its rows so the table can expand to the invoices behind the count.
    const byDealer = new Map<string, Debtor>();
    for (const r of found) {
        const key = r.account_id ?? r.dealer_lead_id ?? `name:${(r.customer_name ?? "").toLowerCase()}`;
        const d = byDealer.get(key) ?? {
            key,
            name: r.dealer_name ?? r.customer_name ?? "(no name)",
            accountId: r.account_id,
            leadId: r.dealer_lead_id,
            owed: 0,
            oldest: null,
            rows: [],
        };
        d.rows.push(r);
        d.owed += r.balance;
        if (r.age_days != null) d.oldest = Math.max(d.oldest ?? 0, r.age_days);
        byDealer.set(key, d);
    }
    for (const d of byDealer.values()) d.owed = Math.max(0, d.owed);
    // Top 15 by default; a search lists every customer it finds.
    const debtors = [...byDealer.values()].sort((a, b) => b.owed - a.owed).slice(0, q ? undefined : 15);
    for (const d of debtors) d.rows.sort((a, b) => b.balance - a.balance);

    const tab = (k: AgeKey, text: string, xs: Row[]) => (
        <Link
            key={k}
            href={`/ceo/receivables?${new URLSearchParams({ ...(k === "all" ? {} : { age: k }), ...(q ? { q } : {}) })}`}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                age === k ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            }`}
        >
            {text} · {xs.length} · {inr(sum(xs))}
        </Link>
    );

    const dealerLink = (name: string, accountId: string | null, leadId: string | null) => {
        const href = accountId
            ? `/admin/accounts/${encodeURIComponent(accountId)}`
            : leadId
              ? `/leads/${encodeURIComponent(leadId)}`
              : null;
        return href ? (
            <Link href={href} className="text-gray-900 hover:text-brand-sky hover:underline">
                {name}
            </Link>
        ) : (
            <span className="text-gray-900">{name}</span>
        );
    };

    return (
        <div className="space-y-6 pb-12">
            <div>
                <Link href="/ceo" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> CEO overview
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">Accounts Receivable</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every Zoho and Drive invoice that is not paid, void or draft and still has a balance — as of now,
                    whatever date it was raised. The amount is the unpaid balance (invoice total minus what has been
                    paid), including GST, less any credit note issued to the same customer (never below zero per
                    customer). Age is days since the invoice or credit note date.
                </p>
                <p className="mt-1 text-xs text-gray-500">{receivablesSourceText(freshness)}</p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                    {
                        k: "Receivable",
                        v: inr(owed),
                        s: `${rows.length - credits.length} invoice${rows.length - credits.length === 1 ? "" : "s"}${
                            credits.length ? ` · less ${credits.length} credit note${credits.length === 1 ? "" : "s"} (${inr(-sum(credits))})` : ""
                        }`,
                    },
                    {
                        k: "Past due date",
                        v: inr(sum(overdue)),
                        s: `${overdue.length} invoices · only invoices that carry a due date`,
                    },
                    { k: "Older than 60 days", v: inr(sum(rows.filter((r) => (r.age_days ?? 0) > 60))), s: "Since the invoice date" },
                    { k: "Not linked to a dealer", v: inr(sum(unlinked)), s: `${unlinked.length} invoices` },
                ].map((t) => (
                    <div key={t.k} className="rounded-xl border border-gray-200 bg-white p-4">
                        <p className="text-xs font-semibold text-gray-500">{t.k}</p>
                        <p className="mt-1 text-xl font-bold text-brand-navy">{t.v}</p>
                        <p className="text-xs text-gray-500">{t.s}</p>
                    </div>
                ))}
            </div>

            <form method="get" className="flex flex-wrap items-center gap-2">
                {age !== "all" && <input type="hidden" name="age" value={age} />}
                <input
                    name="q"
                    defaultValue={q}
                    placeholder="Search any dealer, customer, invoice number or GSTIN"
                    className="w-full max-w-md rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                />
                <button type="submit" className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white">
                    Search
                </button>
                {q && (
                    <Link
                        href={age === "all" ? "/ceo/receivables" : `/ceo/receivables?age=${age}`}
                        className="text-xs font-semibold text-brand-sky hover:underline"
                    >
                        Clear
                    </Link>
                )}
            </form>

            {q && debtors.length === 0 && (
                <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
                    No unpaid invoice matches &ldquo;{q}&rdquo;.
                </p>
            )}

            {debtors.length > 0 && (
                <section className="space-y-2">
                    <h2 className="text-sm font-semibold text-gray-900">
                        {q ? `Customers matching “${q}”` : "Who owes the most"}
                    </h2>
                    <p className="text-xs text-gray-500">Click a customer to see the invoices behind its balance.</p>
                    <DebtorTable debtors={debtors} owed={owed} />
                    {!q && byDealer.size > debtors.length && (
                        <p className="text-xs text-gray-500">Top {debtors.length} of {byDealer.size}. Every invoice is listed below.</p>
                    )}
                </section>
            )}

            <section className="space-y-2">
                <h2 className="text-sm font-semibold text-gray-900">Invoices by age</h2>
                <div className="flex flex-wrap gap-2">
                    {tab("all", "All", found)}
                    {byAge.map((a) => tab(a.key, a.label, q ? a.rows.filter((r) => found.includes(r)) : a.rows))}
                    {noDate.length > 0 && tab("no_date", "No invoice date", q ? noDate.filter((r) => found.includes(r)) : noDate)}
                </div>
            </section>

            {shown.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">Nothing receivable in this group.</p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3">Invoice date</th>
                                <th className="px-4 py-3">Invoice</th>
                                <th className="px-4 py-3">Customer on invoice</th>
                                <th className="px-4 py-3">Matched dealer</th>
                                <th className="px-4 py-3">Owner</th>
                                <th className="px-4 py-3 text-right">Age</th>
                                <th className="px-4 py-3 text-right">Invoice total</th>
                                <th className="px-4 py-3 text-right">Receivable</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {shown.map((r) => (
                                <tr key={`${r.source}:${r.id}`} className="align-top">
                                    <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                                        {r.invoice_date ? fmtDate(r.invoice_date) : "—"}
                                        {r.due_date && <span className="block text-xs text-gray-500">Due {fmtDate(r.due_date)}</span>}
                                    </td>
                                    <td className="whitespace-nowrap px-4 py-3">
                                        {r.document_url ? (
                                            <FreshFileLink
                                                href={r.document_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 font-medium text-brand-sky hover:underline"
                                            >
                                                <FileText className="h-3.5 w-3.5" />
                                                {r.invoice_number ?? "(no number)"}
                                            </FreshFileLink>
                                        ) : (
                                            <span className="font-medium text-gray-900">
                                                {r.invoice_number ?? "(no number)"}
                                                <span className="block text-xs font-normal text-amber-700">{receivableFileNote(r)}</span>
                                            </span>
                                        )}
                                        <span className="block text-xs text-gray-500">
                                            {receivableSourceLabel(r)} · {(r.status ?? "no status").replace(/_/g, " ")}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-gray-800">{r.customer_name ?? "—"}</td>
                                    <td className="px-4 py-3">
                                        {r.dealer_name ? (
                                            dealerLink(r.dealer_name, r.account_id, r.dealer_lead_id)
                                        ) : (
                                            <span className="text-amber-700">Not linked</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-gray-700">{r.owner_name ?? "—"}</td>
                                    <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-700">
                                        {r.age_days == null ? "—" : `${r.age_days} d`}
                                        {r.overdue_days != null && r.overdue_days > 0 && (
                                            <span className="block text-xs font-semibold text-rose-600">{r.overdue_days} d overdue</span>
                                        )}
                                    </td>
                                    <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600">{rupees(r.total)}</td>
                                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-gray-900">
                                        {rupees(r.balance)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className="bg-gray-50 text-sm font-semibold">
                            <tr>
                                <td className="px-4 py-3" colSpan={7}>
                                    Total ({shown.length})
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-right text-brand-navy">{rupees(sum(shown))}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}

            <p className="text-xs text-gray-500">
                Payments are only seen once they are recorded on the invoice (Zoho balance, or amount paid on a Drive
                invoice). Money collected but not yet entered still shows here as owed.
            </p>
        </div>
    );
}
