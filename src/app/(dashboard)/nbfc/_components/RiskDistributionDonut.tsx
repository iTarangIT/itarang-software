/**
 * Live SVG donut chart of risk-card severity distribution for a tenant.
 * Server component — reads risk_card_runs counts directly.
 *
 * Adapted from the website mock (src/components/portal/nbfc/risk/
 * RiskDistributionDonut.tsx) but pulls real data and styles for both light
 * and dark backgrounds.
 */
import { db } from "@/lib/db";
import { riskCardRuns, riskHypotheses } from "@/lib/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

interface Props {
  tenantId: string;
  className?: string;
}

const SEVERITY_COLORS: Record<"high" | "warn" | "ok", string> = {
  high: "#ef4444",
  warn: "#f59e0b",
  ok: "#10b981",
};

const SEVERITY_LABELS: Record<"high" | "warn" | "ok", string> = {
  high: "High alert",
  warn: "Warning",
  ok: "OK",
};

async function fetchLatestSeverityCounts(tenantId: string) {
  // For each hypothesis, take its newest run for this tenant and count by
  // severity. CTE-style — Drizzle doesn't have native window-function helpers
  // so we use raw SQL.
  const rows = await db.execute<{ severity: string; n: number }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (hypothesis_id) severity
      FROM ${riskCardRuns}
      WHERE tenant_id = ${tenantId}
      ORDER BY hypothesis_id, run_at DESC
    )
    SELECT severity, COUNT(*)::int AS n
    FROM latest
    GROUP BY severity
  `);

  const counts = { high: 0, warn: 0, ok: 0 };
  for (const r of rows as Array<{ severity: string; n: number }>) {
    if (r.severity === "high" || r.severity === "warn" || r.severity === "ok") {
      counts[r.severity] = Number(r.n);
    }
  }
  return counts;
}

export default async function RiskDistributionDonut({ tenantId, className = "" }: Props) {
  const counts = await fetchLatestSeverityCounts(tenantId);
  const total = counts.high + counts.warn + counts.ok;

  // Hand-coded hypothesis count for context (so we can say "5 of 13 are AI-derived")
  const totalHyp = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(riskHypotheses)
    .where(and(eq(riskHypotheses.source, "human")))
    .then((r) => r[0]?.n ?? 0);

  const r = 44;
  const circumference = 2 * Math.PI * r;
  const order: Array<keyof typeof counts> = ["high", "warn", "ok"];
  const segs = order.map((k, i) => {
    const start = order.slice(0, i).reduce((a, x) => a + counts[x], 0);
    const pct = total > 0 ? (counts[k] / total) * 100 : 0;
    return {
      key: k,
      label: SEVERITY_LABELS[k],
      color: SEVERITY_COLORS[k],
      count: counts[k],
      pct,
      startPct: total > 0 ? (start / total) * 100 : 0,
    };
  });

  return (
    <section
      className={`rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 ${className}`}
    >
      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-4">
        Risk distribution
      </h4>
      <div className="flex items-center gap-5">
        <svg
          width="120"
          height="120"
          viewBox="0 0 120 120"
          className="shrink-0 -rotate-90"
        >
          {total > 0 ? (
            segs.map((s) => {
              const dash = (s.pct / 100) * circumference;
              const gap = circumference - dash;
              const offset = (-s.startPct / 100) * circumference;
              return (
                <circle
                  key={s.key}
                  cx="60"
                  cy="60"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="14"
                  strokeDasharray={`${dash} ${gap}`}
                  strokeDashoffset={offset}
                />
              );
            })
          ) : (
            <circle cx="60" cy="60" r={r} fill="none" stroke="#cbd5e1" strokeWidth="14" />
          )}
          <text
            x="60"
            y="62"
            textAnchor="middle"
            dominantBaseline="middle"
            transform="rotate(90 60 60)"
            className="fill-slate-900 dark:fill-white"
            fontSize="18"
            fontWeight="700"
          >
            {total.toLocaleString("en-IN")}
          </text>
        </svg>
        <div className="flex-1 space-y-2 min-w-0">
          {segs.map((s) => (
            <div key={s.key} className="flex items-center gap-3 text-xs">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
              />
              <span className="text-slate-600 dark:text-slate-300 flex-1 truncate">
                {s.label}
              </span>
              <span className="text-slate-900 dark:text-white font-semibold tabular-nums">
                {total > 0 ? s.pct.toFixed(0) : 0}%
              </span>
              <span className="text-slate-400 tabular-nums w-8 text-right">
                {s.count}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="text-[10px] text-slate-400 mt-4 border-t border-slate-100 dark:border-slate-800 pt-2">
        {totalHyp} hand-coded + LLM-generated hypotheses. Distribution updates
        on every &quot;Re-run analysis.&quot;
      </p>
    </section>
  );
}
