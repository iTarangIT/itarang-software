/**
 * PortfolioSummaryCards (E-026 — BRD §6.1.3)
 * Renders the six summary cards using GET /api/nbfc/portfolio/summary.
 */
"use client";

import { useEffect, useState } from "react";

interface SummaryResponse {
  total_active_loans: number;
  portfolio_value: number;
  disbursement_this_month: number;
  delinquency_rate: number;
  avg_portfolio_cds: number;
  recovery_value_locked: number;
  computed_at: string;
}

const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);

export default function PortfolioSummaryCards() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/nbfc/portfolio/summary", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (!cancelled) setData(json as SummaryResponse);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="text-sm text-red-600">Failed to load: {error}</div>;
  if (!data) return <div className="text-sm text-gray-500">Loading portfolio summary…</div>;

  const cards: Array<{ label: string; value: string }> = [
    { label: "Total Active Loans", value: inr(data.total_active_loans) },
    { label: "Portfolio Value", value: `₹${inr(data.portfolio_value)}` },
    { label: "Disbursement This Month", value: `₹${inr(data.disbursement_this_month)}` },
    { label: "Delinquency Rate", value: `${data.delinquency_rate.toFixed(2)}%` },
    { label: "Avg Portfolio CDS", value: data.avg_portfolio_cds.toFixed(2) },
    { label: "Recovery Value Locked", value: `₹${inr(data.recovery_value_locked)}` },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
        >
          <div className="text-xs uppercase tracking-wide text-gray-500">{c.label}</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{c.value}</div>
        </div>
      ))}
      <div className="col-span-full text-xs text-gray-400">
        Computed at {new Date(data.computed_at).toLocaleString("en-IN")}
      </div>
    </div>
  );
}
