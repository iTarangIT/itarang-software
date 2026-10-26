"use client";

// "Who owes the most", with each customer expandable to the invoices (and
// credit notes) behind its count and balance. The rows come from the page's
// one listReceivables() read — nothing is fetched here.

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";

import FreshFileLink from "@/components/shared/FreshFileLink";
import type { ReceivableRow } from "@/lib/dashboard/receivables";

export type Debtor = {
    key: string;
    name: string;
    accountId: string | null;
    leadId: string | null;
    owed: number;
    oldest: number | null;
    rows: ReceivableRow[];
};

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

function DealerName({ name, accountId, leadId }: { name: string; accountId: string | null; leadId: string | null }) {
    const href = accountId
        ? `/admin/accounts/${encodeURIComponent(accountId)}`
        : leadId
          ? `/leads/${encodeURIComponent(leadId)}`
          : null;
    return href ? (
        <Link href={href} onClick={(e) => e.stopPropagation()} className="text-gray-900 hover:text-brand-sky hover:underline">
            {name}
        </Link>
    ) : (
        <span className="text-gray-900">{name}</span>
    );
}

export default function DebtorTable({ debtors, owed }: { debtors: Debtor[]; owed: number }) {
    const [open, setOpen] = useState<Set<string>>(new Set());
    const toggle = (k: string) =>
        setOpen((prev) => {
            const next = new Set(prev);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            return next;
        });

    return (
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
                    {debtors.map((d) => {
                        const isOpen = open.has(d.key);
                        const credits = d.rows.filter((r) => r.source === "credit").length;
                        const invoices = d.rows.length - credits;
                        return (
                            <Fragment key={d.key}>
                                <tr
                                    className="cursor-pointer hover:bg-gray-50"
                                    onClick={() => toggle(d.key)}
                                    aria-expanded={isOpen}
                                >
                                    <td className="px-4 py-3">
                                        <span className="flex items-start gap-1.5">
                                            {isOpen ? (
                                                <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                                            ) : (
                                                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                                            )}
                                            <span>
                                                <DealerName name={d.name} accountId={d.accountId} leadId={d.leadId} />
                                                {!d.accountId && !d.leadId && (
                                                    <span className="block text-xs text-amber-700">Not linked to a dealer</span>
                                                )}
                                            </span>
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                                        {invoices}
                                        {credits > 0 && (
                                            <span className="block text-xs text-gray-500">
                                                + {credits} credit note{credits === 1 ? "" : "s"}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">{d.oldest ?? "—"}</td>
                                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-gray-900">
                                        {inr(d.owed)}
                                    </td>
                                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                                        {owed ? `${Math.round((d.owed / owed) * 100)}%` : "—"}
                                    </td>
                                </tr>
                                {isOpen && (
                                    <tr className="bg-gray-50/60">
                                        <td colSpan={5} className="px-4 pb-4 pt-1">
                                            <table className="min-w-full overflow-hidden rounded-lg border border-gray-200 bg-white text-xs">
                                                <thead className="bg-gray-50 text-left font-semibold uppercase tracking-wide text-gray-500">
                                                    <tr>
                                                        <th className="px-3 py-2">Invoice</th>
                                                        <th className="px-3 py-2">Invoice date</th>
                                                        <th className="px-3 py-2">Due date</th>
                                                        <th className="px-3 py-2">Customer on invoice</th>
                                                        <th className="px-3 py-2 text-right">Age</th>
                                                        <th className="px-3 py-2 text-right">Invoice total</th>
                                                        <th className="px-3 py-2 text-right">Owed</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-gray-100">
                                                    {d.rows.map((r) => (
                                                        <tr key={`${r.source}:${r.id}`} className="align-top">
                                                            <td className="whitespace-nowrap px-3 py-2">
                                                                {r.document_url ? (
                                                                    <FreshFileLink
                                                                        href={r.document_url}
                                                                        className="inline-flex items-center gap-1 font-medium text-brand-sky hover:underline"
                                                                    >
                                                                        <FileText className="h-3.5 w-3.5" />
                                                                        {r.invoice_number ?? "(no number)"}
                                                                    </FreshFileLink>
                                                                ) : (
                                                                    <span className="font-medium text-gray-900">
                                                                        {r.invoice_number ?? "(no number)"}
                                                                    </span>
                                                                )}
                                                                <span className="block capitalize text-gray-500">
                                                                    {SOURCE_LABEL[r.source] ?? r.source} ·{" "}
                                                                    {(r.status ?? "no status").replace(/_/g, " ")}
                                                                </span>
                                                            </td>
                                                            <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                                                                {r.invoice_date ? fmtDate(r.invoice_date) : "—"}
                                                            </td>
                                                            <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                                                                {r.due_date ? fmtDate(r.due_date) : "—"}
                                                                {r.overdue_days != null && r.overdue_days > 0 && (
                                                                    <span className="block font-semibold text-rose-600">
                                                                        {r.overdue_days} d overdue
                                                                    </span>
                                                                )}
                                                            </td>
                                                            <td className="px-3 py-2 text-gray-800">{r.customer_name ?? "—"}</td>
                                                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-700">
                                                                {r.age_days == null ? "—" : `${r.age_days} d`}
                                                            </td>
                                                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-600">
                                                                {rupees(r.total)}
                                                            </td>
                                                            <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums text-gray-900">
                                                                {rupees(r.balance)}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                                <tfoot className="bg-gray-50 font-semibold">
                                                    <tr>
                                                        <td className="px-3 py-2" colSpan={6}>
                                                            Net owed ({d.rows.length}, credit notes netted, never below zero)
                                                        </td>
                                                        <td className="whitespace-nowrap px-3 py-2 text-right text-brand-navy">
                                                            {rupees(d.owed)}
                                                        </td>
                                                    </tr>
                                                </tfoot>
                                            </table>
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
