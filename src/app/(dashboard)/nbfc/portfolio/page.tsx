/**
 * /nbfc/portfolio  (E-026 — BRD §6.1.3)
 * Portfolio Overview page — hosts the six summary cards.
 */
import PortfolioSummaryCards from "@/components/nbfc-portal/PortfolioSummaryCards";

export const dynamic = "force-dynamic";

export default function NbfcPortfolioPage() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Portfolio Overview</h1>
        <p className="text-sm text-gray-500">
          Snapshot of your active book, disbursements, delinquency and recovery.
        </p>
      </header>
      <PortfolioSummaryCards />
    </div>
  );
}
