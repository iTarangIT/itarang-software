"use client";

// Tracker ID 72 — gross margin by month and business type. Margin is shown
// only for invoice lines that could be costed; what could not be is stated
// beside it, so a month never reads as more profitable than the data supports.

import { useQuery } from "@tanstack/react-query";

import {
    CardLink,
    DashCard,
    KpiTile,
    LoadingBlock,
    NotAvailable,
    StatusPill,
    TABLE_HEAD,
} from "@/components/dashboard/redesign/primitives";
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
    if (cell.revenue === 0 && cell.not_costed === 0) return <span className="text-ink-muted/50">—</span>;
    return (
        <div className="leading-tight">
            {cell.revenue > 0 ? (
                <>
                    <span className={`font-semibold tabular-nums ${cell.margin < 0 ? "text-danger" : "text-brand-navy"}`}>
                        {formatINRCompact(cell.margin)}
                    </span>
                    <span className="ml-1 text-[11px] text-ink-muted tabular-nums">{pct(cell.margin_pct)}</span>
                </>
            ) : (
                <span className="text-ink-muted">no cost</span>
            )}
            {cell.not_costed > 0 && (
                <div className="text-[11px] text-warning tabular-nums">{formatINRCompact(cell.not_costed)} not costed</div>
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

    // ID 89 — the redesign's card and tiles (DashCard / KpiTile), same figures.
    return (
        <div data-testid="ceo-gross-margin">
        <DashCard
            title="Gross margin"
            caption="Invoice line value before GST, less quantity × the average OEM cost of that product. By month and business type."
        >
            {isLoading && <LoadingBlock label="Calculating…" />}
            {error && <NotAvailable reason={(error as Error).message} />}

            {report && !report.available && (
                <NotAvailable reason="The invoice ledger is not set up on this database yet (migration E-322), so gross margin cannot be calculated." />
            )}

            {report?.available && months.length === 0 && (
                <NotAvailable empty reason="No sales invoices in this period." />
            )}

            {report?.available && months.length > 0 && (
                <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <KpiTile
                            label="Gross margin"
                            value={totals.costed > 0 ? formatINRCompact(totals.margin) : "—"}
                            pill={totals.costed > 0 && totals.margin < 0 ? { text: "Negative", tone: "bad" } : undefined}
                            sub={totals.costed > 0 ? `${pct(totals.margin / totals.costed)} of costed sales` : "nothing costed yet"}
                        />
                        <KpiTile
                            label="Sales costed"
                            value={formatINRCompact(totals.costed)}
                            sub={`of ${formatINRCompact(totals.invoiceRevenue)} invoiced before GST`}
                        />
                        <KpiTile
                            label="Coverage"
                            value={pct(coverage)}
                            pill={
                                coverage == null
                                    ? undefined
                                    : {
                                          text: coverage >= 0.9 ? "Good" : coverage >= 0.5 ? "Partial" : "Low",
                                          tone: coverage >= 0.9 ? "good" : coverage >= 0.5 ? "warn" : "bad",
                                      }
                            }
                            sub="of sales has a margin; the rest has no lines, product or cost"
                        />
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] text-[13px] text-ink">
                            <thead>
                                <tr className={`border-b border-border text-left ${TABLE_HEAD}`}>
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
                                    <tr key={m.month} className="border-b border-border/60 align-top">
                                        <td className="py-2 pr-3 font-semibold text-brand-navy">{monthLabel(m.month)}</td>
                                        <td className="py-2 pr-3 tabular-nums text-ink">
                                            {formatINRCompact(m.invoice_revenue)}
                                            {m.invoices_without_lines > 0 && (
                                                <div className="text-[11px] text-warning">
                                                    {m.invoices_without_lines} of {m.invoices} invoices have no usable lines
                                                </div>
                                            )}
                                            {m.credit_notes > 0 && (
                                                <div className="text-[11px] text-ink-muted">
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
                    <p className="text-xs leading-relaxed text-ink-muted">
                        Margin is on what was sold, not on stock bought. Cost is the product&apos;s average OEM invoice
                        value over the last 180 days, else all its stock, else the OEM price book. Voided invoices are
                        left out and credit notes come off the month, as in revenue. Lines and products are the same as
                        Invoice Ledger › By SKU.
                    </p>
                </>
            )}

            {showMapping && report?.available && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-[13px]">
                    <span className="font-semibold text-brand-navy">Invoice items and their products</span>
                    {unmapped > 0 && <StatusPill tone="warn">{unmapped} not linked in this period</StatusPill>}
                    <span className="ml-auto">
                        <CardLink href={ITEM_MAPPING_HREF}>Link them in Invoice Ledger › Item mapping</CardLink>
                    </span>
                    <span className="w-full text-xs text-ink-muted">
                        One mapping for the whole CRM: what is linked there is used here and in By SKU.
                    </span>
                </div>
            )}
        </DashCard>
        </div>
    );
}
