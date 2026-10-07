// What the CEO overview's "Money owed to us" card is made of: every invoice
// still owed, with the same rule and source the card sums — outstandingTotal()
// is SUM(balance) over revenueUnion() WHERE REVENUE_OUTSTANDING, all-time.
// matchedUnion() is that same union plus the dealer match, so the total at the
// top of this page is the card's number. Ageing is days since the invoice date
// (and days past due where the invoice carries a due date).

import Link from "next/link";
import { sql } from "drizzle-orm";
import { ArrowLeft, FileText } from "lucide-react";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { matchedUnion, REVENUE_OUTSTANDING } from "@/lib/dashboard/revenueSource";

export const dynamic = "force-dynamic";

type Row = {
    source: string;
    id: string;
    invoice_number: string | null;
    invoice_date: string | null;
    due_date: string | null;
    customer_name: string | null;
    total: number;
    balance: number;
    status: string | null;
    document_url: string | null;
    dealer_lead_id: string | null;
    account_id: string | null;
    dealer_name: string | null;
    owner_name: string | null;
    age_days: number | null;
    overdue_days: number | null;
};

const AGES = [
    { key: "0_30", label: "0–30 days", min: 0, max: 30 },
    { key: "31_60", label: "31–60 days", min: 31, max: 60 },
    { key: "61_90", label: "61–90 days", min: 61, max: 90 },
    { key: "90_plus", label: "90+ days", min: 91, max: Infinity },
] as const;
type AgeKey = (typeof AGES)[number]["key"] | "all" | "no_date";

const SOURCE_LABEL: Record<string, string> = { zoho: "Zoho", drive: "Drive", credit: "Credit note" };

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

const ageOf = (r: Row): AgeKey =>
    r.age_days == null ? "no_date" : (AGES.find((a) => r.age_days! >= a.min && r.age_days! <= a.max)?.key ?? "0_30");

export default async function CeoReceivablesPage({
    searchParams,
}: {
    searchParams: Promise<{ age?: string }>;
}) {
    await requireRole(["ceo", "admin"]);
    const sp = await searchParams;
    const validAges: string[] = ["all", "no_date", ...AGES.map((a) => a.key)];
    const age: AgeKey = validAges.includes(sp.age ?? "") ? (sp.age as AgeKey) : "all";

    const inv = await matchedUnion();
    const rows = (
        (await db.execute(sql`
            SELECT r.source, r.id, r.invoice_number, r.invoice_date::text AS invoice_date, r.due_date::text AS due_date,
                   r.customer_name, COALESCE(r.total, 0) AS total, COALESCE(r.balance, 0) AS balance, r.status,
                   r.document_url, r.dealer_lead_id, r.account_id, r.dealer_name, u.name AS owner_name,
                   ((now() AT TIME ZONE 'Asia/Kolkata')::date - r.invoice_date::date) AS age_days,
                   CASE WHEN r.due_date IS NOT NULL
                        THEN ((now() AT TIME ZONE 'Asia/Kolkata')::date - r.due_date::date) END AS overdue_days
              FROM ${inv} r
              LEFT JOIN users u ON u.id::text = r.dealer_owner_id::text
             WHERE ${REVENUE_OUTSTANDING}
             ORDER BY r.balance DESC NULLS LAST
        `)) as unknown as Array<Record<string, unknown>>
    ).map(
        (r) =>
            ({
                ...r,
                total: Number(r.total),
                balance: Number(r.balance),
                age_days: r.age_days == null ? null : Number(r.age_days),
                overdue_days: r.overdue_days == null ? null : Number(r.overdue_days),
            }) as Row,
    );

    const sum = (xs: Row[]) => xs.reduce((a, r) => a + r.balance, 0);
    const owed = sum(rows);
    const overdue = rows.filter((r) => r.overdue_days != null && r.overdue_days > 0);
    const unlinked = rows.filter((r) => r.account_id == null && r.dealer_lead_id == null);
    const byAge = AGES.map((a) => ({ ...a, rows: rows.filter((r) => ageOf(r) === a.key) }));
    const noDate = rows.filter((r) => ageOf(r) === "no_date");
    const shown = age === "all" ? rows : rows.filter((r) => ageOf(r) === age);

    // Who owes the most — the list a collections call starts from.
    const byDealer = new Map<string, { name: string; accountId: string | null; leadId: string | null; n: number; owed: number; oldest: number | null }>();
    for (const r of rows) {
        const key = r.account_id ?? r.dealer_lead_id ?? `name:${(r.customer_name ?? "").toLowerCase()}`;
        const d = byDealer.get(key) ?? {
            name: r.dealer_name ?? r.customer_name ?? "(no name)",
            accountId: r.account_id,
            leadId: r.dealer_lead_id,
            n: 0,
            owed: 0,
            oldest: null,
        };
        d.n += 1;
        d.owed += r.balance;
        if (r.age_days != null) d.oldest = Math.max(d.oldest ?? 0, r.age_days);
        byDealer.set(key, d);
    }
    const debtors = [...byDealer.values()].sort((a, b) => b.owed - a.owed).slice(0, 15);

    const tab = (k: AgeKey, text: string, xs: Row[]) => (
        <Link
            key={k}
            href={k === "all" ? "/ceo/receivables" : `/ceo/receivables?age=${k}`}
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
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">Money owed to us</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every Zoho and Drive invoice that is not paid, void or draft and still has a balance — as of now,
                    whatever date it was raised. The amount is the unpaid balance (invoice total minus what has been
                    paid), including GST. Age is days since the invoice date.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                    { k: "Owed to us", v: inr(owed), s: `${rows.length} invoice${rows.length === 1 ? "" : "s"}` },
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

            {debtors.length > 0 && (
                <section className="space-y-2">
                    <h2 className="text-sm font-semibold text-gray-900">Who owes the most</h2>
                    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                        <table className="min-w-full text-sm">
                            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                <tr>
                                    <th className="px-4 py-3">Dealer / customer</th>
                                    <th className="px-4 py-3 text-right">Invoices</th>
                                    <th className="px-4 py-3 text-right">Oldest (days)</th>
                                    <th className="px-4 py-3 text-right">Owed</th>
                                    <th className="px-4 py-3 text-right">Share</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {debtors.map((d) => (
                                    <tr key={`${d.accountId ?? ""}:${d.leadId ?? ""}:${d.name}`}>
                                        <td className="px-4 py-3">
                                            {dealerLink(d.name, d.accountId, d.leadId)}
                                            {!d.accountId && !d.leadId && (
                                                <span className="block text-xs text-amber-700">Not linked to a dealer</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-right tabular-nums text-gray-700">{d.n}</td>
                                        <td className="px-4 py-3 text-right tabular-nums text-gray-700">{d.oldest ?? "—"}</td>
                                        <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-gray-900">
                                            {inr(d.owed)}
                                        </td>
                                        <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                                            {owed ? `${Math.round((d.owed / owed) * 100)}%` : "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {byDealer.size > debtors.length && (
                        <p className="text-xs text-gray-500">Top {debtors.length} of {byDealer.size}. Every invoice is listed below.</p>
                    )}
                </section>
            )}

            <section className="space-y-2">
                <h2 className="text-sm font-semibold text-gray-900">Invoices by age</h2>
                <div className="flex flex-wrap gap-2">
                    {tab("all", "All", rows)}
                    {byAge.map((a) => tab(a.key, a.label, a.rows))}
                    {noDate.length > 0 && tab("no_date", "No invoice date", noDate)}
                </div>
            </section>

            {shown.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">Nothing owed in this group.</p>
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
                                <th className="px-4 py-3 text-right">Owed</th>
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
                                            <a
                                                href={r.document_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 font-medium text-brand-sky hover:underline"
                                            >
                                                <FileText className="h-3.5 w-3.5" />
                                                {r.invoice_number ?? "(no number)"}
                                            </a>
                                        ) : (
                                            <span className="font-medium text-gray-900">{r.invoice_number ?? "(no number)"}</span>
                                        )}
                                        <span className="block text-xs capitalize text-gray-500">
                                            {SOURCE_LABEL[r.source] ?? r.source} · {(r.status ?? "no status").replace(/_/g, " ")}
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
