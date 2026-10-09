"use client";

// Tracker ID 72 — gross margin by month and business type. Margin is shown
// only for invoice lines that could be costed; what could not be is stated
// beside it, so a month never reads as more profitable than the data supports.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";

import type { GrossMarginReport, MarginCell } from "@/lib/dashboard/grossMargin";
import { LINE_TYPES, LINE_TYPE_LABELS } from "@/lib/sales/salesInvoiceLines";
import { formatINRCompact } from "@/lib/format";

type Payload = { report: GrossMarginReport };

/** ID 147 — the ONE item → product mapping, shared with By SKU. */
const ITEM_MAPPING_HREF = "/admin/reports/invoice-ledger?tab=items";

const QUERY_KEY = ["ceo-gross-margin"];

function monthLabel(ym: string): string {
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

function pct(v: number | null): string {
    return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function MarginCellView({ cell }: { cell: MarginCell }) {
    if (cell.revenue === 0 && cell.not_costed === 0) return <span className="text-gray-300">—</span>;
    return (
        <div className="leading-tight">
            {cell.revenue > 0 ? (
                <>
                    <span className={`font-semibold tabular-nums ${cell.margin < 0 ? "text-rose-700" : "text-gray-900"}`}>
                        {formatINRCompact(cell.margin)}
                    </span>
                    <span className="ml-1 text-[11px] text-gray-500 tabular-nums">{pct(cell.margin_pct)}</span>
                </>
            ) : (
                <span className="text-gray-400">no cost</span>
            )}
            {cell.not_costed > 0 && (
                <div className="text-[10px] text-amber-700 tabular-nums">{formatINRCompact(cell.not_costed)} not costed</div>
            )}
        </div>
    );
}

export function GrossMarginPanel({ showMapping = false }: { showMapping?: boolean }) {
    const { data, isLoading, error } = useQuery<Payload>({
        queryKey: QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/dashboard/ceo/gross-margin", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load gross margin");
            return json.data;
        },
        staleTime: 5 * 60 * 1000,
    });

    const report = data?.report;
    const months = [...(report?.months ?? [])].reverse();
    const totals = months.reduce(
        (t, m) => ({
            invoiceRevenue: t.invoiceRevenue + m.invoice_revenue,
            costed: t.costed + m.total.revenue,
            margin: t.margin + m.total.margin,
        }),
        { invoiceRevenue: 0, costed: 0, margin: 0 },
    );
    const coverage = totals.invoiceRevenue > 0 ? totals.costed / totals.invoiceRevenue : null;
    const unmapped = report?.unmapped_items ?? 0;

    return (
        <div data-testid="ceo-gross-margin" className="p-5 rounded-2xl bg-white border border-gray-100 shadow-sm">
            <div className="flex items-start gap-2">
                <TrendingUp className="mt-0.5 h-4 w-4 text-brand-600" />
                <div>
                    <h3 className="text-sm font-semibold text-gray-900">Gross margin</h3>
                    <p className="text-xs text-gray-500">
                        Invoice line value before GST, less quantity × the average OEM cost of that product. By
                        month and business type.
                    </p>
                </div>
            </div>

            {isLoading && <p className="mt-4 text-xs text-gray-400">Calculating…</p>}
            {error && <p className="mt-4 text-xs text-rose-700">{(error as Error).message}</p>}

            {report && !report.available && (
                <p className="mt-4 text-xs text-amber-700">
                    The invoice ledger is not set up on this database yet (migration E-322), so gross margin cannot be
                    calculated.
                </p>
            )}

            {report?.available && months.length === 0 && (
                <p className="mt-4 text-xs text-gray-500">No sales invoices in this period.</p>
            )}

            {report?.available && months.length > 0 && (
                <>
                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                            <p className="text-[11px] font-medium text-gray-600">Gross margin</p>
                            <p className={`mt-1 text-xl font-bold tabular-nums ${totals.margin < 0 ? "text-rose-700" : "text-gray-900"}`}>
                                {totals.costed > 0 ? formatINRCompact(totals.margin) : "—"}
                            </p>
                            <p className="text-[11px] text-gray-500 tabular-nums">
                                {totals.costed > 0 ? `${pct(totals.margin / totals.costed)} of costed sales` : "nothing costed yet"}
                            </p>
                        </div>
                        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                            <p className="text-[11px] font-medium text-gray-600">Sales costed</p>
                            <p className="mt-1 text-xl font-bold tabular-nums text-gray-900">{formatINRCompact(totals.costed)}</p>
                            <p className="text-[11px] text-gray-500 tabular-nums">
                                of {formatINRCompact(totals.invoiceRevenue)} invoiced before GST
                            </p>
                        </div>
                        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                            <p className="text-[11px] font-medium text-gray-600">Coverage</p>
                            <p
                                className={`mt-1 text-xl font-bold tabular-nums ${
                                    coverage == null ? "text-gray-400" : coverage >= 0.9 ? "text-emerald-700" : coverage >= 0.5 ? "text-amber-700" : "text-rose-700"
                                }`}
                            >
                                {pct(coverage)}
                            </p>
                            <p className="text-[11px] text-gray-500">of sales has a margin; the rest has no lines, product or cost</p>
                        </div>
                    </div>

                    <div className="mt-4 overflow-x-auto">
                        <table className="w-full min-w-[640px] text-xs">
                            <thead>
                                <tr className="border-b border-gray-100 text-left text-[11px] font-medium text-gray-500">
                                    <th className="py-2 pr-3">Month</th>
                                    <th className="py-2 pr-3">Invoiced (before GST)</th>
                                    <th className="py-2 pr-3">Gross margin</th>
                                    {LINE_TYPES.map((t) => (
                                        <th key={t} className="py-2 pr-3">{LINE_TYPE_LABELS[t]}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {months.map((m) => (
                                    <tr key={m.month} className="border-b border-gray-50 align-top">
                                        <td className="py-2 pr-3 font-medium text-gray-900">{monthLabel(m.month)}</td>
                                        <td className="py-2 pr-3 tabular-nums text-gray-700">
                                            {formatINRCompact(m.invoice_revenue)}
                                            {m.invoices_without_lines > 0 && (
                                                <div className="text-[10px] text-amber-700">
                                                    {m.invoices_without_lines} of {m.invoices} invoices have no usable lines
                                                </div>
                                            )}
                                            {m.credit_notes > 0 && (
                                                <div className="text-[10px] text-gray-500">
                                                    after {formatINRCompact(m.credit_notes)} credit notes
                                                </div>
                                            )}
                                        </td>
                                        <td className="py-2 pr-3"><MarginCellView cell={m.total} /></td>
                                        {LINE_TYPES.map((t) => (
                                            <td key={t} className="py-2 pr-3"><MarginCellView cell={m.by_type[t]} /></td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="mt-2 text-[11px] text-gray-500">
                        Margin is on what was sold, not on stock bought. Cost is the product&apos;s average OEM invoice
                        value over the last 180 days, else all its stock, else the OEM price book. Voided invoices are
                        left out and credit notes come off the month, as in revenue. Lines and products are the same as
                        Invoice Ledger › By SKU.
                    </p>
                </>
            )}

            {showMapping && report?.available && (
                <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4 text-xs">
                    <span className="font-semibold text-gray-900">Invoice items and their products</span>
                    {unmapped > 0 && (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                            {unmapped} not linked in this period
                        </span>
                    )}
                    <Link href={ITEM_MAPPING_HREF} className="font-semibold text-brand-700 hover:underline">
                        Link them in Invoice Ledger › Item mapping
                    </Link>
                    <span className="w-full text-[11px] text-gray-500">
                        One mapping for the whole CRM: what is linked there is used here and in By SKU.
                    </span>
                </div>
            )}
        </div>
    );
}
