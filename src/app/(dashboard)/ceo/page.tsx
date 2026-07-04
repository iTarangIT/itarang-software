"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { KPICard } from "@/components/shared/kpi-card";
import { MetricsChart } from "@/components/shared/charts";
import { BusinessSnapshotPanel } from "@/components/dashboard/ceo/BusinessSnapshotPanel";
import { ExpenseBreakdownPanel } from "@/components/dashboard/ceo/ExpenseBreakdownPanel";
import { ExpenseLedgerPanel } from "@/components/dashboard/ceo/ExpenseLedgerPanel";
import { RevenueMtdCard } from "@/components/dashboard/ceo/RevenueMtdCard";
import { ExpensesMtdCard } from "@/components/dashboard/ceo/ExpensesMtdCard";
import {
  DrillDownModal,
  type DrillMetric,
} from "@/components/dashboard/ceo/DrillDownModal";
import { DashboardSkeleton } from "@/components/dashboard/ceo/DashboardSkeleton";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import {
  TrendingUp,
  Package,
  AlertCircle,
  ArrowRight,
  UserCheck,
  Briefcase,
  Users,
  FileSignature,
  Clock,
  RefreshCw,
  CalendarRange,
  X,
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

  const [trendGranularity, setTrendGranularity] = React.useState<
    "month" | "week" | "day"
  >("month");
  // Optional calendar range to compare a chosen span; empty = default lookback.
  const [trendStart, setTrendStart] = React.useState("");
  const [trendEnd, setTrendEnd] = React.useState("");

  const {
    data: metrics,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["dashboard-metrics", "ceo", trendGranularity, trendStart, trendEnd],
    queryFn: async () => {
      const params = new URLSearchParams({ trendGranularity });
      if (trendStart) params.set("trendStart", trendStart);
      if (trendEnd) params.set("trendEnd", trendEnd);
      const response = await fetch(`/api/dashboard/ceo?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch dashboard metrics");
      const result = await response.json();
      return result.data; // API returns { data: ... }
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
  const leadsTotal = Number(m.leadsTotal ?? 0);
  const leadsConverted = Number(m.leadsConverted ?? 0);

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

      {/* KPI Section */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        <div data-testid="kpi-revenue-mtd">
          <RevenueMtdCard
            base={Number(m.revenue_mtd ?? m.revenue ?? 0)}
            voidAmount={Number(m.revenue_void_mtd ?? 0)}
            fyBase={Number(m.revenue_fytd ?? 0)}
            fyVoidAmount={Number(m.revenue_void_fytd ?? 0)}
            fyStartLabel={m.fyStartLabel}
            change={
              typeof m.revenueChange === "number" ? m.revenueChange : null
            }
          />
        </div>
        <KPICard
          title="Outstanding Credits"
          value={formatINRCompact(Number(m.outstandingCredits ?? 0))}
          exactValue={formatINRExact(Number(m.outstandingCredits ?? 0))}
          subtitle="Unpaid invoice balances"
          icon={AlertCircle}
          onClick={() =>
            setDrill({ metric: "outstanding", title: "Outstanding Credits" })
          }
        />
        <ExpensesMtdCard
          defaultMtd={Number(m.other_expenses_mtd ?? 0)}
          onClick={(period) =>
            setDrill({
              metric: "expenses",
              title: "Approved Expenses",
              params: period,
            })
          }
        />
        <KPICard
          title="Inventory Value"
          value={formatINRCompact(Number(m.inventoryValue ?? 0))}
          exactValue={formatINRExact(Number(m.inventoryValue ?? 0))}
          subtitle="Total stock on hand"
          icon={Package}
          onClick={() =>
            setDrill({ metric: "inventory", title: "Inventory on Hand" })
          }
        />
        <KPICard
          title="Lead Qualification Rate"
          value={`${Number(m.conversionRate ?? 0).toFixed(1)}%`}
          subtitle={
            leadsTotal > 0
              ? `${leadsConverted} of ${leadsTotal} leads this month`
              : "No leads this month"
          }
          change={
            typeof m.conversionChange === "number"
              ? {
                  value: Number(Math.abs(m.conversionChange).toFixed(1)),
                  period: "vs last month",
                  isPositive: m.conversionChange >= 0,
                }
              : undefined
          }
          icon={TrendingUp}
        />
      </div>

      {/* Charts and Details Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
        {/* Left rail: revenue trend + operational cards */}
        <div className="lg:col-span-2 space-y-6">
          <div className="h-[440px]">
            <MetricsChart
              title="Revenue Performance Trend"
              data={m.revenueTrend || []}
              dataKeys={["revenue"]}
              categoryKey="name"
              type="bar"
              height={300}
              valueFormatter={(v) => `₹${Number(v).toFixed(1)}L`}
              headerActions={
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  <div className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 h-8">
                    <CalendarRange className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <input
                      type="date"
                      value={trendStart}
                      max={trendEnd || undefined}
                      onChange={(e) => setTrendStart(e.target.value)}
                      aria-label="Compare from"
                      className="bg-transparent text-xs text-gray-600 outline-none w-[104px]"
                    />
                    <span className="text-gray-300">–</span>
                    <input
                      type="date"
                      value={trendEnd}
                      min={trendStart || undefined}
                      onChange={(e) => setTrendEnd(e.target.value)}
                      aria-label="Compare to"
                      className="bg-transparent text-xs text-gray-600 outline-none w-[104px]"
                    />
                    {(trendStart || trendEnd) && (
                      <button
                        type="button"
                        aria-label="Clear date range"
                        onClick={() => {
                          setTrendStart("");
                          setTrendEnd("");
                        }}
                        className="ml-0.5 grid place-items-center h-5 w-5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="inline-flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
                    {(["day", "week", "month"] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setTrendGranularity(g)}
                        className={`px-3 h-7 text-xs font-semibold rounded-md transition-colors ${
                          trendGranularity === g
                            ? "bg-white text-gray-900 shadow-sm"
                            : "text-gray-500 hover:text-gray-700"
                        }`}
                      >
                        {g === "day" ? "Daily" : g === "week" ? "Weekly" : "Monthly"}
                      </button>
                    ))}
                  </div>
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

          {/* Full expense ledger — every tracked expense, read-only */}
          <ExpenseLedgerPanel rows={m.ai_expenses || []} />
        </div>

        {/* Right rail: financial snapshot + signing queue */}
        <div className="space-y-6">
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
