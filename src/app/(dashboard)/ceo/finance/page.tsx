"use client";

// "Revenue & costs" (spec ID 89). Revenue and gross margin by month and
// business type (tracker ID 72) with the item → product linking the margin
// depends on, plus the money panels that used to sit on the CEO overview:
// realization, the business snapshot, expenses by department and project, the
// procurement summary and the full expense ledger. One window control drives
// the windowed panels, as it did on the overview.

import React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Briefcase } from "lucide-react";

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
import { formatINRCompact } from "@/lib/format";

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

    const m = metrics || {};
    const windowLabel = overview?.label ?? "this period";

    return (
        <div className="space-y-6 pb-12">
            <div>
                <h1 className="text-xl font-semibold text-gray-900">Revenue &amp; costs</h1>
                <p className="text-sm text-gray-500">
                    A management view, not the accountant&apos;s books.{" "}
                    <Link href="/ceo/invoices" className="font-semibold text-brand-700 hover:underline">
                        Sales invoices
                    </Link>
                    {" · "}
                    <Link href="/ceo/expenses" className="font-semibold text-brand-700 hover:underline">
                        Expense approvals
                    </Link>
                </p>
            </div>

            <GrossMarginPanel showMapping />

            <div className="flex items-center justify-between gap-4 flex-wrap">
                <CeoFilterBar value={win} onChange={setWin} />
                {overview && <span className="text-xs font-medium text-gray-400">Showing {overview.label}</span>}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                <div className="lg:col-span-2 space-y-6">
                    {/* Full expense ledger — fetches, filters and totals server-side for
                        the window selected above. */}
                    <ExpenseLedgerPanel params={windowParams} />
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

                    <div data-testid="business-snapshot-panel-wrapper">
                        <BusinessSnapshotPanel
                            purchasesMtd={Number(m.purchases_mtd ?? 0)}
                            salesMtd={Number(m.revenue_mtd ?? 0)}
                            otherExpensesMtd={Number(m.other_expenses_mtd ?? 0)}
                            recentInvoices={m.recent_invoices || []}
                            recentExpenses={m.recent_expenses || []}
                            onTileClick={(metric, title, params) => setDrill({ metric, title, params })}
                        />
                    </div>

                    <ExpenseBreakdownPanel
                        byDepartment={m.expenses_by_department || []}
                        byProject={m.expenses_by_project || []}
                    />

                    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm flex flex-col">
                        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                            <Briefcase className="w-4 h-4 text-brand-600" />
                            Procurement Overview
                        </h3>
                        <div className="space-y-4 flex-1 flex flex-col">
                            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                                <span className="text-xs font-medium text-gray-600">Pending Approvals</span>
                                <span className="text-xs font-bold text-brand-700">
                                    {m.procurementStats?.pendingApprovals || 0} Items
                                </span>
                            </div>
                            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                                <span className="text-xs font-medium text-gray-600">Active Procurement</span>
                                <span className="text-xs font-bold text-blue-700">
                                    {formatINRCompact(Number(m.procurementStats?.activeValue ?? 0))}
                                </span>
                            </div>
                            <Link href="/procurement" className="mt-auto">
                                <button className="w-full py-2.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
                                    Review Procurement <ArrowRight className="w-3 h-3" />
                                </button>
                            </Link>
                        </div>
                    </div>
                </div>
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
