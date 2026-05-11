/**
 * /nbfc/portfolio  (E-026 + E-027 — BRD §6.1.3)
 * Portfolio Overview — six summary cards plus the data freshness badge.
 */
import DataFreshnessBadge from "@/components/nbfc-portal/DataFreshnessBadge";
import PortfolioSummaryCards from "@/components/nbfc-portal/PortfolioSummaryCards";

export const dynamic = "force-dynamic";

export default function NbfcPortfolioPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="section-label-muted">Portfolio</p>
          <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
            Portfolio Overview
          </h1>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            Snapshot of your active book, disbursements, delinquency and
            recovery — refreshed live as the underlying loans report.
          </p>
        </div>
        <DataFreshnessBadge />
      </header>
      <PortfolioSummaryCards />
    </div>
  );
}
