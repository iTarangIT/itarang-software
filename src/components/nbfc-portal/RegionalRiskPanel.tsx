/**
 * RegionalRiskPanel — at-risk share of the active book by borrower city.
 * Bar width is proportional to the at-risk percentage; the bar tone steps
 * red / amber / green by risk band.
 */
import type { RegionalRiskRow } from "@/lib/nbfc/command-centre";

function bandColor(pct: number): string {
  if (pct >= 30) return "var(--color-danger)";
  if (pct >= 15) return "var(--color-warning)";
  return "var(--color-success)";
}

export default function RegionalRiskPanel({
  rows,
}: {
  rows: RegionalRiskRow[];
}) {
  return (
    <section className="card-iTarang p-5 h-full" data-testid="cc-regional">
      <h2 className="text-base font-semibold text-[color:var(--color-brand-navy)]">
        Regional risk
      </h2>
      <p className="mt-1 text-[12px] text-[color:var(--color-ink-muted)]">
        At-risk share of the active book by borrower city.
      </p>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-[color:var(--color-ink-muted)]">
          No active loans with a recorded city yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((r) => (
            <li key={r.city} data-testid="cc-regional-row">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium text-[color:var(--color-brand-navy)] truncate">
                  {r.city}
                </span>
                <span className="text-[12px] text-[color:var(--color-ink-muted)] tabular-nums shrink-0">
                  {r.at_risk_count}/{r.loan_count} ·{" "}
                  <span className="font-semibold text-[color:var(--color-brand-navy)]">
                    {r.at_risk_pct.toFixed(1)}%
                  </span>
                </span>
              </div>
              <div
                className="mt-1.5 h-2 w-full rounded-full overflow-hidden"
                style={{ background: "var(--color-info-bg)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, Math.max(r.at_risk_pct, r.at_risk_count > 0 ? 4 : 0))}%`,
                    background: bandColor(r.at_risk_pct),
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
