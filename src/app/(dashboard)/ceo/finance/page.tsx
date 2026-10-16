"use client";

// "Revenue & costs" (spec ID 89). Revenue and gross margin by month and
// business type (tracker ID 72) with the item → product linking the margin
// depends on, plus the money panels that used to sit on the CEO overview:
// realization, the business snapshot, expenses by department and project, the
// procurement summary and the full expense ledger. One window control drives
// the windowed panels, as it did on the overview.
//
// ID 89 — revenue, costs, the net and money owed by age now sit on this one
// page: a net strip for the selected window and the receivables ageing (the
// same buckets as "Money owed to us"), in the redesign's card style.

import React from "react";
import { useQuery } from "@tanstack/react-query";

import { GrossMarginPanel } from "@/components/dashboard/ceo/GrossMarginPanel";
import { BusinessSnapshotPanel } from "@/components/dashboard/ceo/BusinessSnapshotPanel";
import { ExpenseBreakdownPanel } from "@/components/dashboard/ceo/ExpenseBreakdownPanel";
import { ExpenseLedgerPanel } from "@/components/dashboard/ceo/ExpenseLedgerPanel";
import {
    CeoFilterBar,
    ceoWindowParams,
    DEFAULT_CEO_WINDOW,
    type CeoWindow,
} from "@/components/dashboard/ceo/CeoFilterBar";
import { RealizationCard, type CeoOverviewData } from "@/components/dashboard/ceo/CeoOverviewCards";
import { RealizationDrillDown } from "@/components/dashboard/ceo/RealizationDrillDown";
import { DrillDownModal, type DrillMetric } from "@/components/dashboard/ceo/DrillDownModal";
import {
    CardLink,
    DashCard,
    DashPageHeader,
    KpiTile,
    LoadingBlock,
    NotAvailable,
    inr,
} from "@/components/dashboard/redesign/primitives";
import type { ReceivablesAgeing } from "@/lib/dashboard/receivables";

/** The snapshot-summary payload: sales − purchases − other expenses for a window. */
type NetSummary = { purchases: number; sales: number; otherExpenses: number; net: number; label: string };

/** primitives' inr() is for positive figures; the net can go negative. */
const signedInr = (n: number) => `${n < 0 ? "−" : ""}${inr(Math.abs(n))}`;

export default function RevenueAndCostsPage() {
    const [win, setWin] = React.useState<CeoWindow>(DEFAULT_CEO_WINDOW);
    const [drill, setDrill] = React.useState<{ metric: DrillMetric; title: string; params?: string } | null>(null);
    const [realizationOpen, setRealizationOpen] = React.useState(false);
    const windowParams = ceoWindowParams(win).toString();

    const { data: metrics } = useQuery({
        queryKey: ["dashboard-metrics", "ceo"],
        queryFn: async () => {
            const response = await fetch(`/api/dashboard/ceo`);
            if (!response.ok) throw new Error("Failed to fetch dashboard metrics");
            return (await response.json()).data;
        },
        refetchInterval: 60000,
    });
    const { data: overview } = useQuery<CeoOverviewData>({
        queryKey: ["ceo-overview", windowParams],
        queryFn: async () => {
            const res = await fetch(`/api/dashboard/ceo/overview?${windowParams}`);
            if (!res.ok) throw new Error("Failed to load overview");
            return (await res.json()).data as CeoOverviewData;
        },
        refetchInterval: 60000,
    });
    // ID 89 — the net for the page's window. Same route and rule as the Business
    // snapshot below (and the overview's "Revenue minus purchases and
    // expenses" line), asked with this page's window.
    const net = useQuery<NetSummary>({
        queryKey: ["ceo-snapshot-summary", "window", windowParams],
        queryFn: async () => {
            const res = await fetch(`/api/dashboard/ceo/snapshot-summary?${windowParams}`, { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load the net");
            return (await res.json()).data as NetSummary;
        },
        placeholderData: (prev) => prev,
    });
    // ID 89 — money owed by age; all-time as of today, like /ceo/receivables.
    const ageing = useQuery<ReceivablesAgeing>({
        queryKey: ["ceo-receivables-ageing"],
        queryFn: async () => {
            const res = await fetch(`/api/dashboard/ceo/receivables-ageing`, { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load money owed");
            return (await res.json()).data as ReceivablesAgeing;
        },
        refetchInterval: 5 * 60_000,
    });

    const m = metrics || {};
    const windowLabel = overview?.label ?? "this period";

    return (
        <div className="space-y-6 pb-12">
            <DashPageHeader
                sticky
                eyebrow="Money"
                title="Revenue & costs"
                subtitle="A management view, not the accountant's books."
                footer={
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <CeoFilterBar value={win} onChange={setWin} />
                        {overview && <span className="text-xs font-medium text-ink-muted">Showing {overview.label}</span>}
                    </div>
                }
            >
                <CardLink href="/ceo/invoices">Sales invoices</CardLink>
                <CardLink href="/ceo/expenses">Expense approvals</CardLink>
            </DashPageHeader>

            {/* E-224 removed a "Net" strip from the Business snapshot because it
                sat under the tiles reading like Realization. This one is named for
                exactly what it subtracts and says how it differs. */}
            <DashCard
                title="Revenue minus purchases and expenses"
                caption={net.data ? net.data.label : windowLabel}
            >
                {net.isLoading ? (
                    <LoadingBlock />
                ) : net.isError || !net.data ? (
                    <NotAvailable reason="The figures for this window could not be loaded." />
                ) : (
                    <>
                        <div data-testid="net-strip" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <KpiTile label="Revenue" value={inr(net.data.sales)} sub="Sales invoices, void excluded" />
                            <KpiTile
                                label="Stock bought from OEMs"
                                value={`−${inr(net.data.purchases)}`}
                                sub="By OEM invoice date"
                            />
                            <KpiTile
                                label="Running expenses"
                                value={`−${inr(net.data.otherExpenses)}`}
                                sub="Approved expenses"
                            />
                            <KpiTile
                                label="Net"
                                value={signedInr(net.data.net)}
                                pill={{ text: net.data.net >= 0 ? "Positive" : "Negative", tone: net.data.net >= 0 ? "good" : "bad" }}
                            />
                        </div>
                        <span className="text-xs leading-relaxed text-ink-muted">
                            This counts stock bought, not stock sold, so a window of heavy stocking reads negative. It is
                            not Realization (revenue − expense, below), which leaves OEM purchases out.
                        </span>
                    </>
                )}
            </DashCard>

            <DashCard
                title="Money owed to us, by age"
                caption="As of today, every unpaid invoice whatever its date — the period above does not apply."
                action={<CardLink href="/ceo/receivables">Open money owed to us</CardLink>}
            >
                {ageing.isLoading ? (
                    <LoadingBlock />
                ) : ageing.isError || !ageing.data ? (
                    <NotAvailable reason="Money owed could not be loaded." />
                ) : (
                    <>
                        <div data-testid="receivables-ageing" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {ageing.data.buckets.map((b) => (
                                <KpiTile
                                    key={b.key}
                                    label={b.label}
                                    value={inr(b.amount)}
                                    sub={`${b.invoices} invoice${b.invoices === 1 ? "" : "s"}`}
                                    href={`/ceo/receivables?age=${b.key}`}
                                />
                            ))}
                        </div>
                        <span className="text-xs text-ink-muted">
                            Total owed {inr(ageing.data.owed)} across {ageing.data.invoices} invoice
                            {ageing.data.invoices === 1 ? "" : "s"}. Age is days since the invoice date.
                        </span>
                    </>
                )}
            </DashCard>

            <GrossMarginPanel showMapping />

            {/* ID 89 — every panel in the redesign's card look. The business
                snapshot gets the wide column so its three tiles sit in a row. */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                <div className="lg:col-span-2" data-testid="business-snapshot-panel-wrapper">
                    <BusinessSnapshotPanel
                        purchasesMtd={Number(m.purchases_mtd ?? 0)}
                        salesMtd={Number(m.revenue_mtd ?? 0)}
                        otherExpensesMtd={Number(m.other_expenses_mtd ?? 0)}
                        recentInvoices={m.recent_invoices || []}
                        recentExpenses={m.recent_expenses || []}
                        onTileClick={(metric, title, params) => setDrill({ metric, title, params })}
                    />
                </div>

                <div className="space-y-6">
                    {overview && (
                        <div data-testid="kpi-realization">
                            <RealizationCard
                                data={overview.realization}
                                windowLabel={windowLabel}
                                onClick={() => setRealizationOpen(true)}
                            />
                        </div>
                    )}

                    <DashCard title="Procurement">
                        <div className="flex items-center justify-between rounded-xl border border-border bg-bg px-3 py-2.5">
                            <span className="text-[13px] font-medium text-ink-muted">Pending approvals</span>
                            <span className="text-[13px] font-bold tabular-nums text-brand-navy">
                                {m.procurementStats?.pendingApprovals || 0} items
                            </span>
                        </div>
                        <div className="flex items-center justify-between rounded-xl border border-border bg-bg px-3 py-2.5">
                            <span className="text-[13px] font-medium text-ink-muted">Active procurement</span>
                            <span className="text-[13px] font-bold tabular-nums text-brand-navy">
                                {inr(Number(m.procurementStats?.activeValue ?? 0))}
                            </span>
                        </div>
                        <CardLink href="/procurement">Review procurement</CardLink>
                    </DashCard>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                <div className="lg:col-span-2">
                    {/* Full expense ledger — fetches, filters and totals server-side for
                        the window selected above. */}
                    <ExpenseLedgerPanel params={windowParams} />
                </div>
                <ExpenseBreakdownPanel
                    byDepartment={m.expenses_by_department || []}
                    byProject={m.expenses_by_project || []}
                />
            </div>

            {realizationOpen && overview && (
                <RealizationDrillDown
                    data={overview.realization}
                    windowLabel={windowLabel}
                    onOpenMetric={(metric, title) => {
                        // Carry the SAME window into the row-level list, so it adds up to
                        // the figure that opened it.
                        setRealizationOpen(false);
                        setDrill({ metric, title, params: windowParams });
                    }}
                    onClose={() => setRealizationOpen(false)}
                />
            )}

            {drill && (
                <DrillDownModal
                    metric={drill.metric}
                    title={drill.title}
                    params={drill.params}
                    onClose={() => setDrill(null)}
                />
            )}
        </div>
    );
}
