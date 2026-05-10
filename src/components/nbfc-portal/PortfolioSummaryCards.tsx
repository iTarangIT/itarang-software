/**
 * PortfolioSummaryCards (E-026 — BRD §6.1.3)
 *
 * Six summary cards rendered against /api/nbfc/portfolio/summary. Visual
 * language inherits from the admin chrome (`card-iTarang`, navy + sky
 * accent) so the NBFC partner reads this surface as the same product.
 */
"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  AlertOctagon,
  CircleDollarSign,
  Gauge,
  Layers3,
  TrendingUp,
} from "lucide-react";

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

type CardSpec = {
  key: string;
  label: string;
  value: string;
  caption: string;
  Icon: React.ComponentType<{ className?: string }>;
  tone: "neutral" | "success" | "warning";
};

function toneStyles(tone: CardSpec["tone"]) {
  if (tone === "success") {
    return {
      iconWrap: { background: "var(--color-success-bg)" },
      iconColor: "var(--color-success)",
    };
  }
  if (tone === "warning") {
    return {
      iconWrap: { background: "var(--color-warning-bg)" },
      iconColor: "var(--color-warning)",
    };
  }
  return {
    iconWrap: { background: "var(--color-info-bg)" },
    iconColor: "var(--color-brand-sky)",
  };
}

export default function PortfolioSummaryCards() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/nbfc/portfolio/summary", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          let detail = `HTTP ${r.status}`;
          try {
            const body = await r.json();
            if (body?.error) detail = `${detail} — ${body.error}`;
          } catch {
            // non-JSON body (e.g. Next.js 404 HTML) — keep status only
          }
          throw new Error(detail);
        }
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

  if (error) {
    return (
      <div
        className="card-iTarang p-5 text-sm"
        style={{ color: "var(--color-danger)" }}
        data-testid="portfolio-summary-error"
      >
        Failed to load portfolio summary: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="portfolio-summary-loading"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card-iTarang p-5 animate-pulse">
            <div className="h-3 w-24 bg-[color:var(--color-border)] rounded" />
            <div className="h-7 w-32 bg-[color:var(--color-border)] rounded mt-3" />
            <div className="h-3 w-40 bg-[color:var(--color-border)] rounded mt-3" />
          </div>
        ))}
      </div>
    );
  }

  const cards: CardSpec[] = [
    {
      key: "total_active_loans",
      label: "Total Active Loans",
      value: inr(data.total_active_loans),
      caption: "Disbursed and not yet closed.",
      Icon: Layers3,
      tone: "neutral",
    },
    {
      key: "portfolio_value",
      label: "Portfolio Value",
      value: `₹${inr(data.portfolio_value)}`,
      caption: "Sum of loan_amount across active book.",
      Icon: CircleDollarSign,
      tone: "neutral",
    },
    {
      key: "disbursement_this_month",
      label: "Disbursement This Month",
      value: `₹${inr(data.disbursement_this_month)}`,
      caption: "Calendar month, IST.",
      Icon: TrendingUp,
      tone: "success",
    },
    {
      key: "delinquency_rate",
      label: "Delinquency Rate",
      value: `${data.delinquency_rate.toFixed(2)}%`,
      caption: "Active loans with EMI overdue > 30 days.",
      Icon: AlertOctagon,
      tone: data.delinquency_rate > 5 ? "warning" : "neutral",
    },
    {
      key: "avg_portfolio_cds",
      label: "Avg Portfolio CDS",
      value: data.avg_portfolio_cds.toFixed(2),
      caption: "Borrower credit score, refreshed daily.",
      Icon: Gauge,
      tone: "neutral",
    },
    {
      key: "recovery_value_locked",
      label: "Recovery Value Locked",
      value: `₹${inr(data.recovery_value_locked)}`,
      caption: "Estimated value in recovery pipeline.",
      Icon: Activity,
      tone: "neutral",
    },
  ];

  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      data-testid="portfolio-summary-cards"
    >
      {cards.map((c) => {
        const tone = toneStyles(c.tone);
        return (
          <div
            key={c.key}
            data-testid={`portfolio-card-${c.key}`}
            className="card-iTarang p-5 transition-shadow hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="section-label-muted">{c.label}</p>
              <span
                className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                style={tone.iconWrap}
              >
                <c.Icon
                  className="w-4 h-4"
                  style={{ color: tone.iconColor }}
                />
              </span>
            </div>
            <p className="mt-3 text-[28px] leading-tight font-semibold text-[color:var(--color-brand-navy)] tabular-nums">
              {c.value}
            </p>
            <p className="mt-2 text-[12px] text-[color:var(--color-ink-muted)]">
              {c.caption}
            </p>
          </div>
        );
      })}
      <p className="col-span-full text-[11px] text-[color:var(--color-ink-muted)] mt-1">
        Computed at {new Date(data.computed_at).toLocaleString("en-IN")}
      </p>
    </div>
  );
}
