"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { MetricsChart } from "@/components/shared/charts";
import { BusinessSnapshotPanel } from "@/components/dashboard/ceo/BusinessSnapshotPanel";
import { ExpenseBreakdownPanel } from "@/components/dashboard/ceo/ExpenseBreakdownPanel";
import { ExpenseLedgerPanel } from "@/components/dashboard/ceo/ExpenseLedgerPanel";
import { QuotationApprovalsPanel } from "@/components/dashboard/ceo/PendingQuotationsPanel";
import {
  CeoFilterBar,
  ceoWindowParams,
  DEFAULT_CEO_WINDOW,
  type CeoWindow,
} from "@/components/dashboard/ceo/CeoFilterBar";
import {
  BuybackCard,
  LeadsCard,
  RealizationCard,
  type CeoOverviewData,
} from "@/components/dashboard/ceo/CeoOverviewCards";
import { GreenKmCard } from "@/components/dashboard/ceo/GreenKmCard";
import { RealizationDrillDown } from "@/components/dashboard/ceo/RealizationDrillDown";
import {
  DrillDownModal,
  type DrillMetric,
} from "@/components/dashboard/ceo/DrillDownModal";
import { DashboardSkeleton } from "@/components/dashboard/ceo/DashboardSkeleton";
import { formatINRCompact } from "@/lib/format";
import {
  AlertCircle,
  ArrowRight,
  UserCheck,
  Briefcase,
  Users,
  FileSignature,
  Clock,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { lspStatusToneClass } from "@/components/admin/nbfc/lspStatusTone";

type NbfcSigningRow = {
  nbfcId: number;
  nbfcShortId: string;
  legalName: string;
  agreementStatus: string;
  signed: number;
  total: number;
};

export default function CEODashboard() {
  const [drill, setDrill] = React.useState<{
    metric: DrillMetric;
    title: string;
    params?: string;
  } | null>(null);
  const [realizationOpen, setRealizationOpen] = React.useState(false);

  // E-219 — one window for the whole page. The cards, the Realization
  // drill-down and the chart all read it, so nothing on screen can be showing a
  // different span from the control above it.
  const [win, setWin] = React.useState<CeoWindow>(DEFAULT_CEO_WINDOW);
  // Bucket size for the chart only. The window says how far back to look; this
  // says how finely to slice it, and defaults to whatever suits the span.
  const [granularity, setGranularity] = React.useState<
    "day" | "week" | "month" | null
  >(null);

  const windowParams = ceoWindowParams(win);

  const {
    data: metrics,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["dashboard-metrics", "ceo"],
    queryFn: async () => {
      const response = await fetch(`/api/dashboard/ceo`);
      if (!response.ok) throw new Error("Failed to fetch dashboard metrics");
      const result = await response.json();
      return result.data; // API returns { data: ... }
    },
    refetchInterval: 60000,
  });

  const overviewParams = new URLSearchParams(windowParams);
  if (granularity) overviewParams.set("granularity", granularity);

  const {
    data: overview,
    isLoading: overviewLoading,
    error: overviewError,
  } = useQuery<CeoOverviewData>({
    queryKey: ["ceo-overview", overviewParams.toString()],
    queryFn: async () => {
      const res = await fetch(
        `/api/dashboard/ceo/overview?${overviewParams.toString()}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || "Failed to load overview");
      }
      const json = await res.json();
      return json.data as CeoOverviewData;
    },
    refetchInterval: 60000,
  });

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-16 p-8 rounded-2xl bg-white border border-gray-100 shadow-sm text-center">
        <div className="w-12 h-12 rounded-full bg-rose-50 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-6 h-6 text-rose-500" />
        </div>
        <h3 className="text-base font-bold text-gray-900">
          Couldn&apos;t load the dashboard
        </h3>
        <p className="text-sm text-gray-500 mt-1.5">
          We hit a problem fetching your metrics. This is usually temporary.
        </p>
        <button
          onClick={() => refetch()}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          <RefreshCw
            className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
          />
          Retry
        </button>
      </div>
    );
  }

  const m = metrics || {};
  const lastUpdatedLabel = m.lastUpdated
    ? new Date(m.lastUpdated).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const windowLabel = overview?.label ?? "this period";

  return (
    <div className="space-y-8 pb-12">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            CEO Executive Overview
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Real-time business performance and strategic metrics.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdatedLabel && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-gray-50 border border-gray-100 rounded-full px-3 py-1.5">
              <Clock
                className={`w-3.5 h-3.5 ${isFetching ? "animate-spin text-brand-600" : ""}`}
              />
              As of {lastUpdatedLabel} · auto-refreshes
            </span>
          )}
          <Link href="/leads">
            <Button className="bg-brand-600 hover:bg-brand-700 text-white flex items-center gap-2">
              <Users className="w-4 h-4" />
              Go to Leads
            </Button>
          </Link>
        </div>
      </div>

      {/* E-219 — the window control every figure below reads. */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <CeoFilterBar
          value={win}
          onChange={(next) => {
            setWin(next);
            // The new span picks its own bucket size; an override chosen for
            // the previous window would otherwise persist onto one it suits
            // badly (daily bars across a financial year).
            setGranularity(null);
          }}
        />
        {overview && (
          <span className="text-xs font-medium text-gray-400">
            Showing {overview.label}
          </span>
        )}
      </div>

      {/* KPI Section */}
      {overviewError ? (
        <div
          data-testid="ceo-overview-error"
          className="p-4 rounded-2xl bg-rose-50 border border-rose-100 text-sm text-rose-700"
        >
          Couldn&apos;t load the headline figures for this period:{" "}
          {(overviewError as Error).message}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div data-testid="kpi-realization">
            {overviewLoading || !overview ? (
              <CardSkeleton />
            ) : (
              <RealizationCard
                data={overview.realization}
                windowLabel={windowLabel}
                onClick={() => setRealizationOpen(true)}
              />
            )}
          </div>
          <div data-testid="kpi-leads">
            {overviewLoading || !overview ? (
              <CardSkeleton />
            ) : (
              <LeadsCard data={overview.leads} windowLabel={windowLabel} />
            )}
          </div>
          <div data-testid="kpi-green-km">
            <GreenKmCard window={win} />
          </div>
          <div data-testid="kpi-buyback">
            {overviewLoading || !overview ? (
              <CardSkeleton />
            ) : (
              <BuybackCard data={overview.buyback} windowLabel={windowLabel} />
            )}
          </div>
        </div>
      )}

      {/* Charts and Details Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
        {/* Left rail: revenue trend + operational cards */}
        <div className="lg:col-span-2 space-y-6">
          {/* E-219 — replaced "Revenue Performance Trend". Revenue and expense
              as bars, realization as the line tracing the gap between them, all
              on one ₹ axis. */}
          <div className="h-[460px]" data-testid="realization-trend-chart">
            <MetricsChart
              title="Revenue, Expense & Realization"
              data={overview?.chart ?? []}
              dataKeys={["revenue", "expense", "realization"]}
              lineKeys={["realization"]}
              seriesLabels={{
                revenue: "Revenue",
                expense: "Expense",
                realization: "Realization",
              }}
              categoryKey="name"
              type="composed"
              height={320}
              valueFormatter={(v) => formatINRCompact(Number(v))}
              headerActions={
                <div className="inline-flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
                  {(["day", "week", "month"] as const).map((g) => {
                    // Null granularity means "whatever the window implies", so
                    // the button the server actually used is the one that lights up.
                    const active = (granularity ?? overview?.granularity) === g;
                    return (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setGranularity(g)}
                        className={`px-3 h-7 text-xs font-semibold rounded-md transition-colors ${
                          active
                            ? "bg-white text-gray-900 shadow-sm"
                            : "text-gray-500 hover:text-gray-700"
                        }`}
                      >
                        {g === "day" ? "Daily" : g === "week" ? "Weekly" : "Monthly"}
                      </button>
                    );
                  })}
                </div>
              }
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm flex flex-col">
              <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-brand-600" />
                Procurement Overview
              </h3>
              <div className="space-y-4 flex-1 flex flex-col">
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                  <span className="text-xs font-medium text-gray-600">
                    Pending Approvals
                  </span>
                  <span className="text-xs font-bold text-brand-700">
                    {m.procurementStats?.pendingApprovals || 0} Items
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                  <span className="text-xs font-medium text-gray-600">
                    Active Procurement
                  </span>
                  <span className="text-xs font-bold text-blue-700">
                    {formatINRCompact(
                      Number(m.procurementStats?.activeValue ?? 0),
                    )}
                  </span>
                </div>
                <Link href="/procurement" className="mt-auto">
                  <button className="w-full py-2.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
                    Review Procurement <ArrowRight className="w-3 h-3" />
                  </button>
                </Link>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-brand-600 shadow-lg shadow-brand-500/20 text-white relative overflow-hidden flex flex-col">
              <div className="relative z-10 flex flex-col h-full">
                <UserCheck className="w-8 h-8 opacity-40 mb-4" />
                <h3 className="text-lg font-bold">HR Management</h3>
                <p className="text-xs text-brand-100 mt-1 opacity-80 leading-relaxed">
                  Monitor employee performance and manage sales head allocations
                  directly from the HR console.
                </p>
                <Link href="/hr" className="mt-auto pt-4">
                  <button className="px-4 py-2 bg-white text-brand-700 text-xs font-bold rounded-lg shadow-sm hover:bg-brand-50 transition-colors">
                    Open Console
                  </button>
                </Link>
              </div>
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16 blur-2xl"></div>
            </div>
          </div>

          {/* Full expense ledger — every tracked expense, read-only. Takes the
              page window rather than a row array: it fetches, filters and
              totals server-side so its figures answer the period selected
              above instead of the newest 200 invoices ever recorded. */}
          <ExpenseLedgerPanel params={windowParams.toString()} />
        </div>

        {/* Right rail: quotation approvals + financial snapshot + signing queue */}
        <div className="space-y-6">
          {/* E-221 — first in the rail because it blocks someone else's work:
              a rep cannot send a quote until the CEO acts on it here. */}
          <QuotationApprovalsPanel />

          <div data-testid="business-snapshot-panel-wrapper">
            <BusinessSnapshotPanel
              purchasesMtd={Number(m.purchases_mtd ?? 0)}
              salesMtd={Number(m.revenue_mtd ?? 0)}
              otherExpensesMtd={Number(m.other_expenses_mtd ?? 0)}
              recentInvoices={m.recent_invoices || []}
              recentExpenses={m.recent_expenses || []}
              onTileClick={(metric, title, params) =>
                setDrill({ metric, title, params })
              }
            />
          </div>

          <ExpenseBreakdownPanel
            byDepartment={m.expenses_by_department || []}
            byProject={m.expenses_by_project || []}
          />

          <NbfcSigningCard
            rows={(m.nbfcSigningQueue ?? []) as NbfcSigningRow[]}
          />
        </div>
      </div>

      {/* NBFC Agreements in Signing — populated by the CEO dashboard
                API once the CEO clicks "Approve & Send Agreement for Signing"
                and Digio starts collecting signatures. Empty until any NBFC
                has an agreement in flight. */}

      {/* Sales Teams Overview */}
      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Top Performing Sales Managers
          </h3>
          <Link href="/sales-head">
            <button className="text-xs font-semibold text-brand-700 hover:underline">
              View All Teams
            </button>
          </Link>
        </div>
        {(m.topSalesManagers || []).length === 0 ? (
          <div className="py-10 text-center">
            <Users className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-500">
              No ranked managers yet
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Rankings appear once leads are assigned and qualified.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {(m.topSalesManagers || []).map((manager: any) => (
              <Link key={manager.id} href={`/sales-head/${manager.id}`}>
                <div className="flex items-center gap-4 p-4 rounded-xl border border-gray-50 bg-gray-50/50 hover:bg-white hover:border-brand-100 transition-all cursor-pointer group">
                  <div className="w-11 h-11 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-sm shrink-0">
                    {manager.name
                      .split(" ")
                      .map((n: string) => n[0])
                      .join("")
                      .slice(0, 2)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-900 truncate">
                      {manager.name}
                    </p>
                    <p className="text-[11px] text-gray-500 font-medium uppercase tracking-wider">
                      {manager.region}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-brand-700">
                      {manager.conversion}
                    </p>
                    <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">
                      Conv.
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {realizationOpen && overview && (
        <RealizationDrillDown
          data={overview.realization}
          windowLabel={windowLabel}
          onOpenMetric={(metric, title) => {
            // Hand off to the row-level list, carrying the SAME window — a
            // drill-down that quietly reverted to this month would not add up
            // to the figure that opened it.
            setRealizationOpen(false);
            setDrill({ metric, title, params: windowParams.toString() });
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

/** Placeholder with the card's footprint, so the row doesn't reflow on load. */
function CardSkeleton() {
  return (
    <div className="p-6 rounded-2xl bg-white/80 border border-gray-100 shadow-sm animate-pulse">
      <div className="h-4 w-24 bg-gray-100 rounded" />
      <div className="h-8 w-32 bg-gray-100 rounded mt-3" />
      <div className="h-3 w-40 bg-gray-50 rounded mt-3" />
    </div>
  );
}

function NbfcSigningCard({ rows }: { rows: NbfcSigningRow[] }) {
  const MAX_VISIBLE = 3;
  const visibleRows = rows.slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, rows.length - MAX_VISIBLE);

  return (
    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <FileSignature className="w-4 h-4 text-brand-600" />
        NBFC Agreements in Signing
        {rows.length > 0 && (
          <span className="ml-auto text-[11px] font-bold text-brand-700 bg-brand-50 border border-brand-100 rounded-full px-2 py-0.5">
            {rows.length} awaiting
          </span>
        )}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-500 leading-relaxed">
          No agreements awaiting signatures. Approve a pending NBFC to send the
          auto-filled agreement to its signers via Digio.
        </p>
      ) : (
        <div className="space-y-3">
          {visibleRows.map((row) => (
            <Link
              key={row.nbfcId}
              href={`/admin/nbfc/${row.nbfcId}/review`}
              className="block p-3 rounded-xl bg-gray-50 border border-gray-100 hover:bg-white hover:border-brand-100 transition-all"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-gray-900 truncate">
                    {row.legalName}
                  </p>
                  <p className="text-[10px] font-mono text-gray-400 mt-0.5">
                    {row.nbfcShortId}
                  </p>
                </div>
                <ArrowRight className="w-3 h-3 text-gray-400 shrink-0 mt-1" />
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className={lspStatusToneClass(row.agreementStatus)}>
                  {row.agreementStatus}
                </span>
                {row.total > 0 && (
                  <span className="text-[11px] text-gray-500 font-mono">
                    Signed {row.signed}/{row.total}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
      <Link href="/admin/nbfc/approvals">
        <button className="w-full py-2.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 rounded-xl transition-colors flex items-center justify-center gap-2 mt-4">
          {hiddenCount > 0
            ? `View all (${rows.length})`
            : "Pending NBFC Approvals"}{" "}
          <ArrowRight className="w-3 h-3" />
        </button>
      </Link>
    </div>
  );
}
