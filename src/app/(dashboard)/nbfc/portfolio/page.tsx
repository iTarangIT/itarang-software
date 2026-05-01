/**
 * NBFC Portfolio Overview placeholder page.
 *
 * The full implementation of the portfolio dashboard (summary cards
 * for Total Active Loans, Portfolio Value, Avg EMI, Delinquency Rate,
 * Disbursement This Month, plus cross-time charts) is delivered by
 * unit E-026 per BRD §6.1.3. This shell only exists so the sidebar
 * navigation in E-025 has a real destination to link to.
 */
export default function NbfcPortfolioPage() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Portfolio Overview</h1>
      <p className="text-sm text-slate-500">
        Portfolio summary cards and charts will appear here.
      </p>
    </div>
  );
}
