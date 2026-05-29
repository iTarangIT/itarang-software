/**
 * /nbfc/portfolio — Portfolio Command Centre (BRD §6.1.3)
 *
 * The active book, live risk alerts, regional risk and recovery on one
 * surface. Replaces the earlier flat 7-card "Portfolio Overview". The static
 * header renders server-side; CommandCentreBody fetches and renders the live
 * sections; DataFreshnessBadge keeps its own /freshness call.
 */
import DataFreshnessBadge from "@/components/nbfc-portal/DataFreshnessBadge";
import CommandCentreBody from "@/components/nbfc-portal/CommandCentreBody";

export const dynamic = "force-dynamic";

export default function NbfcPortfolioPage() {
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="section-label-muted">Portfolio</p>
          <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
            Portfolio Command Centre
          </h1>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            Your active book, live risk alerts and recovery — refreshed as the
            underlying loans and telemetry report.
          </p>
        </div>
        <DataFreshnessBadge />
      </header>
      <CommandCentreBody />
    </div>
  );
}
