// What the CEO overview's Revenue card is made of: every invoice in the
// period, from the same source and with the same rule the card sums —
// matchedUnion() (Zoho + Drive + credit notes, matched to dealers by GSTIN)
// with REVENUE_NOT_VOID over [from, to]. So the total at the top of this page
// is the card's number, and "not linked" is the card's "₹X not linked".

import Link from "next/link";
import { sql } from "drizzle-orm";
import { ArrowLeft, FileText } from "lucide-react";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";

export const dynamic = "force-dynamic";

type Row = {
    source: string;
    id: string;
    invoice_number: string | null;
    invoice_date: string;
    customer_name: string | null;
    total: number;
    status: string | null;
    document_url: string | null;
    dealer_lead_id: string | null;
    account_id: string | null;
    dealer_name: string | null;
    owner_name: string | null;
    match_status: string;
};

const SHOW = ["all", "linked", "unlinked"] as const;
type Show = (typeof SHOW)[number];

const SOURCE_LABEL: Record<string, string> = { zoho: "Zoho", drive: "Drive", credit: "Credit note" };
const MATCH_LABEL: Record<string, string> = {
    credited: "Linked",
    no_owner: "Linked · no owner",
    unknown: "GSTIN matches no dealer",
    not_dealer: "No GSTIN / not a dealer sale",
};

const rupees = (n: number) => `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const inr = (n: number) =>
    Math.abs(n) >= 1e7
        ? `₹${(n / 1e7).toFixed(2)} Cr`
        : Math.abs(n) >= 1e5
          ? `₹${(n / 1e5).toFixed(2)} L`
          : rupees(Math.round(n));
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const nextDay = (d: string) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10);
};
const fmtDate = (d: string) =>
    new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    });

export default async function CeoRevenuePage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string; label?: string; show?: string }>;
}) {
    await requireRole(["ceo", "admin"]);
    const sp = await searchParams;

    // Default: this month to today, like the CEO page's default period.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    let from = isDate(sp.from) ? sp.from : `${today.slice(0, 7)}-01`;
    let to = isDate(sp.to) ? sp.to : today;
    if (from > to) [from, to] = [to, from];
    const show: Show = (SHOW as readonly string[]).includes(sp.show ?? "") ? (sp.show as Show) : "all";
    const label = sp.label?.trim() || null;

    const inv = await matchedUnion();
    const rows = (
        (await db.execute(sql`
            SELECT r.source, r.id, r.invoice_number, r.invoice_date::text AS invoice_date, r.customer_name,
                   COALESCE(r.total, 0) AS total, r.status, r.document_url,
                   r.dealer_lead_id, r.account_id, r.dealer_name, u.name AS owner_name, r.match_status
              FROM ${inv} r
              LEFT JOIN users u ON u.id::text = r.dealer_owner_id::text
             WHERE ${REVENUE_NOT_VOID}
               AND r.invoice_date >= ${from}::date AND r.invoice_date < ${nextDay(to)}::date
             ORDER BY r.invoice_date DESC, r.invoice_number DESC
        `)) as unknown as Array<Record<string, unknown>>
    ).map((r) => ({ ...r, total: Number(r.total) }) as Row);

    // "Linked" exactly as the card counts it: matched to a dealer lead or account.
    const linked = (r: Row) => r.dealer_lead_id != null || r.account_id != null;
    const sum = (xs: Row[]) => xs.reduce((a, r) => a + r.total, 0);
    const total = sum(rows);
    const linkedRows = rows.filter(linked);
    const unlinkedRows = rows.filter((r) => !linked(r));
    const bySource = ["drive", "zoho", "credit"]
        .map((s) => ({ s, rows: rows.filter((r) => r.source === s) }))
        .filter((x) => x.rows.length > 0);
    const shown = show === "linked" ? linkedRows : show === "unlinked" ? unlinkedRows : rows;

    const qs = (s: Show) =>
        `/ceo/revenue?from=${from}&to=${to}${label ? `&label=${encodeURIComponent(label)}` : ""}${s === "all" ? "" : `&show=${s}`}`;
    const tab = (s: Show, text: string, n: number, v: number) => (
        <Link
            href={qs(s)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                show === s ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            }`}
        >
            {text} · {n} · {inr(v)}
        </Link>
    );

    return (
        <div className="space-y-6 pb-12">
            <div>
                <Link href="/ceo" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> CEO overview
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">Revenue</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    {label ? `${label} · ` : ""}
                    {fmtDate(from)} – {fmtDate(to)}. Every non-void invoice dated in the period, from Zoho and Drive,
                    with credit notes subtracted. Totals include GST; this is billed, not collected.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                    { k: "Revenue", v: inr(total), s: `${rows.length} document${rows.length === 1 ? "" : "s"}` },
                    { k: "Linked to a dealer", v: inr(sum(linkedRows)), s: `${linkedRows.length} invoices` },
                    { k: "Not linked to a dealer", v: inr(sum(unlinkedRows)), s: `${unlinkedRows.length} invoices` },
                ].map((t) => (
                    <div key={t.k} className="rounded-xl border border-gray-200 bg-white p-4">
                        <p className="text-xs font-semibold text-gray-500">{t.k}</p>
                        <p className="mt-1 text-xl font-bold text-brand-navy">{t.v}</p>
                        <p className="text-xs text-gray-500">{t.s}</p>
                    </div>
                ))}
            </div>

            {bySource.length > 0 && (
                <p className="text-xs text-gray-600">
                    By source:{" "}
                    {bySource
                        .map((x) => `${SOURCE_LABEL[x.s] ?? x.s} ${inr(sum(x.rows))} (${x.rows.length})`)
                        .join(" · ")}
                </p>
            )}

            <div className="flex flex-wrap gap-2">
                {tab("all", "All", rows.length, total)}
                {tab("linked", "Linked", linkedRows.length, sum(linkedRows))}
                {tab("unlinked", "Not linked", unlinkedRows.length, sum(unlinkedRows))}
            </div>

            {shown.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    No invoices dated in this period.
                </p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3">Date</th>
                                <th className="px-4 py-3">Invoice</th>
                                <th className="px-4 py-3">Customer on invoice</th>
                                <th className="px-4 py-3">Matched dealer</th>
                                <th className="px-4 py-3">Owner</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3 text-right">Amount</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {shown.map((r) => (
                                <tr key={`${r.source}:${r.id}`} className="align-top">
                                    <td className="whitespace-nowrap px-4 py-3 text-gray-700">{fmtDate(r.invoice_date)}</td>
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
                                        <span className="block text-xs text-gray-500">{SOURCE_LABEL[r.source] ?? r.source}</span>
                                    </td>
                                    <td className="px-4 py-3 text-gray-800">{r.customer_name ?? "—"}</td>
                                    <td className="px-4 py-3">
                                        {r.dealer_name ? (
                                            r.dealer_lead_id ? (
                                                <Link
                                                    href={`/leads/${encodeURIComponent(r.dealer_lead_id)}`}
                                                    className="text-gray-900 hover:text-brand-sky hover:underline"
                                                >
                                                    {r.dealer_name}
                                                </Link>
                                            ) : (
                                                <span className="text-gray-900">{r.dealer_name}</span>
                                            )
                                        ) : (
                                            <span className="text-amber-700">Not linked</span>
                                        )}
                                        <span className="block text-xs text-gray-500">
                                            {MATCH_LABEL[r.match_status] ?? r.match_status}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-gray-700">{r.owner_name ?? "—"}</td>
                                    <td className="px-4 py-3 capitalize text-gray-700">{(r.status ?? "—").replace(/_/g, " ")}</td>
                                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-gray-900">{rupees(r.total)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className="bg-gray-50 text-sm font-semibold">
                            <tr>
                                <td className="px-4 py-3" colSpan={6}>
                                    Total ({shown.length})
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-right text-brand-navy">{rupees(sum(shown))}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}

            {unlinkedRows.length > 0 && (
                <p className="text-xs text-gray-500">
                    &ldquo;Not linked&rdquo; invoices count in revenue but cannot be credited to a dealer or salesperson —
                    usually the invoice has no GSTIN, or its GSTIN is not on any dealer account. Link them on{" "}
                    <Link href="/ceo/invoices" className="font-semibold text-brand-sky hover:underline">
                        Sales invoices
                    </Link>
                    .
                </p>
            )}
        </div>
    );
}
