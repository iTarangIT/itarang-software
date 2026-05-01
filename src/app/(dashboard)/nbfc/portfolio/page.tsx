/**
 * /nbfc/portfolio  (E-026 + E-027 — BRD §6.1.3)
 * Portfolio Overview page — hosts the six summary cards and the data
 * freshness badge that surfaces stale-IoT warnings.
 */
import DataFreshnessBadge from "@/components/nbfc-portal/DataFreshnessBadge";
import PortfolioSummaryCards from "@/components/nbfc-portal/PortfolioSummaryCards";

export const dynamic = "force-dynamic";

export default function NbfcPortfolioPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Portfolio Overview</h1>
          <p className="text-sm text-gray-500">
            Snapshot of your active book, disbursements, delinquency and recovery.
          </p>
        </div>
        <DataFreshnessBadge />
      </header>
      <PortfolioSummaryCards />
    </div>
  );
}
