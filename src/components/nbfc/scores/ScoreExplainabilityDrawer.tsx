/**
 * ScoreExplainabilityDrawer (E-092 — BRD §6.4.5)
 *
 * Side drawer that opens whenever a CDS or PCI score badge in the NBFC portal
 * is clicked. Renders, per BRD:
 *   - the plain-language formula
 *   - the last-6 EMI input table (newest first) with per-row contribution
 *   - a HIGH/MEDIUM/LOW confidence badge + reasons
 *   - the four-item "when NOT to trust this score" list
 *   - an "Override" affordance (requires nbfc_risk_manager) when available
 *
 * Data is fetched from GET /api/nbfc/scores/explainability — the drawer never
 * recomputes the score locally, satisfying the explainability NFR (no drift
 * between the displayed number and the surface that explains it).
 */
"use client";

import { useEffect, useState } from "react";

interface EmiRow {
  due_date: string | null;
  amount: number | null;
  status: string | null;
  days_late: number | null;
  emi_weight: number | null;
  recency_multiplier: number | null;
  contribution: number | null;
}

interface CdsBreakdown {
  weighted_sum: number;
  recency_total: number;
  streak_count: number;
  streak_penalty: number;
  telemetry_risk: number;
  weighted_sum_max: number;
  streak_max: number;
  telemetry_max: number;
  numerator: number;
  denominator: number;
  raw_score: number;
  cds_score: number;
}

interface CdsReference {
  formula: string;
  emi_weight_rules: { label: string; condition: string; weight: number }[];
  recency_schedule: { position: number; multiplier: number }[];
  streak_rule: string;
  telemetry_rule: string;
}

interface ExplainabilityResponse {
  ok: true;
  score_type: "cds" | "pci";
  score_value: number;
  formula_text: string;
  inputs: { last_6_emis: EmiRow[] };
  breakdown: CdsBreakdown | null;
  reference: CdsReference | null;
  confidence: { level: "HIGH" | "MEDIUM" | "LOW"; reasons: string[] };
  when_not_to_trust: string[];
  override: { available: boolean; required_role: string };
  computed_at: string;
}

interface ErrorResponse {
  ok: false;
  error: string;
}

interface Props {
  loanSanctionId: string;
  scoreType: "cds" | "pci";
  open: boolean;
  onClose: () => void;
  /** Optional override CTA. Parent owns the actual override flow. */
  onOverrideClick?: () => void;
}

const LEVEL_BADGE: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
  HIGH: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  MEDIUM: "bg-amber-100 text-amber-800 ring-amber-300",
  LOW: "bg-rose-100 text-rose-800 ring-rose-300",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

function formatAmount(n: number | null): string {
  if (n === null) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
}

function MathRow({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? "font-semibold text-gray-900" : "text-gray-600"}>
        {label}
        {hint && (
          <span className="ml-1 text-[11px] text-gray-400">({hint})</span>
        )}
      </dt>
      <dd
        className={`tabular-nums ${strong ? "text-base font-bold text-gray-900" : "font-medium text-gray-800"}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function ScoreExplainabilityDrawer({
  loanSanctionId,
  scoreType,
  open,
  onClose,
  onOverrideClick,
}: Props) {
  const [data, setData] = useState<ExplainabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const url = `/api/nbfc/scores/explainability?loan_sanction_id=${encodeURIComponent(
      loanSanctionId,
    )}&score_type=${scoreType}`;

    const run = async () => {
      // setState inside an async function (not synchronously in the effect
      // body) keeps react-hooks/set-state-in-effect happy.
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const res = await fetch(url, { cache: "no-store" });
        const json: ExplainabilityResponse | ErrorResponse = await res.json();
        if (cancelled) return;
        if (!res.ok || !("ok" in json) || !json.ok) {
          setError(("error" in json && json.error) || `HTTP ${res.status}`);
        } else {
          setData(json);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [open, loanSanctionId, scoreType]);

  if (!open) return null;

  const isCds = data?.score_type === "cds";

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={`${scoreType.toUpperCase()} score explainability`}
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {scoreType.toUpperCase()} Score · Explainability
            </h2>
            <p className="text-xs text-gray-500">Loan {loanSanctionId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            aria-label="Close drawer"
          >
            ×
          </button>
        </header>

        {loading && <p className="text-sm text-gray-500">Loading…</p>}

        {error && (
          <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            Could not load explainability: {error}
          </div>
        )}

        {data && (
          <div className="space-y-5">
            <section className="flex items-baseline gap-3">
              <div className="text-3xl font-bold text-gray-900">
                {data.score_value.toFixed(2)}
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${LEVEL_BADGE[data.confidence.level]}`}
              >
                {data.confidence.level} confidence
              </span>
              <span className="ml-auto text-xs text-gray-500">
                computed {formatDate(data.computed_at)}
              </span>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Formula
              </h3>
              <p className="rounded bg-gray-50 p-3 font-mono text-xs text-gray-800">
                {data.formula_text}
              </p>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Last 6 EMIs (newest first)
              </h3>
              {data.inputs.last_6_emis.length === 0 ? (
                <p className="text-sm text-gray-500">No EMI history available.</p>
              ) : (
                <>
                  <table className="w-full text-xs">
                    <thead className="text-left text-gray-500">
                      <tr>
                        <th className="py-1">Due date</th>
                        <th className="py-1">Amount</th>
                        <th className="py-1">Status</th>
                        <th className="py-1 text-right">Days late</th>
                        {isCds && (
                          <>
                            <th className="py-1 text-right">EMI weight</th>
                            <th className="py-1 text-right">Recency ×</th>
                          </>
                        )}
                        <th className="py-1 text-right">Contribution</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {data.inputs.last_6_emis.map((row, i) => (
                        <tr key={i}>
                          <td className="py-1.5">{formatDate(row.due_date)}</td>
                          <td className="py-1.5">₹{formatAmount(row.amount)}</td>
                          <td className="py-1.5">{row.status ?? "—"}</td>
                          <td className="py-1.5 text-right">
                            {row.days_late ?? "—"}
                          </td>
                          {isCds && (
                            <>
                              <td className="py-1.5 text-right tabular-nums">
                                {row.emi_weight === null
                                  ? "—"
                                  : row.emi_weight.toFixed(2)}
                              </td>
                              <td className="py-1.5 text-right tabular-nums text-gray-500">
                                {row.recency_multiplier === null
                                  ? "—"
                                  : `× ${row.recency_multiplier.toFixed(2)}`}
                              </td>
                            </>
                          )}
                          <td className="py-1.5 text-right font-medium tabular-nums">
                            {row.contribution === null
                              ? "—"
                              : row.contribution.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {isCds && (
                    <p className="mt-1 text-[11px] text-gray-400">
                      Contribution = EMI weight × recency multiplier.
                    </p>
                  )}
                </>
              )}
            </section>

            {isCds && data.breakdown && (
              <section className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  How this score is calculated
                </h3>
                <dl className="space-y-1 text-xs text-gray-700">
                  <MathRow
                    label="Sum of EMI contributions"
                    value={data.breakdown.weighted_sum.toFixed(2)}
                    hint={`out of a possible ${data.breakdown.weighted_sum_max.toFixed(2)}`}
                  />
                  <MathRow
                    label="Streak penalty"
                    value={`+ ${data.breakdown.streak_penalty.toFixed(2)}`}
                    hint={
                      data.breakdown.streak_count > 0
                        ? `${data.breakdown.streak_count} consecutive missed/overdue`
                        : "no current streak"
                    }
                  />
                  <MathRow
                    label="Stale-telemetry risk"
                    value={`+ ${data.breakdown.telemetry_risk.toFixed(2)}`}
                    hint={`max ${data.breakdown.telemetry_max.toFixed(2)}`}
                  />
                  <div className="my-1 border-t border-dashed border-gray-300" />
                  <MathRow
                    label="Risk total (numerator)"
                    value={data.breakdown.numerator.toFixed(2)}
                  />
                  <MathRow
                    label="Worst-case total (denominator)"
                    value={data.breakdown.denominator.toFixed(2)}
                    hint={`${data.breakdown.weighted_sum_max.toFixed(2)} + ${data.breakdown.streak_max.toFixed(2)} + ${data.breakdown.telemetry_max.toFixed(2)}`}
                  />
                  <MathRow
                    label="Scaled to 0–100"
                    value={data.breakdown.cds_score.toFixed(2)}
                    hint={`${data.breakdown.numerator.toFixed(2)} ÷ ${data.breakdown.denominator.toFixed(2)} × 100`}
                    strong
                  />
                </dl>
                {Math.abs(data.breakdown.cds_score - data.score_value) > 0.01 && (
                  <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                    Stored score is {data.score_value.toFixed(2)} (computed{" "}
                    {formatDate(data.computed_at)}). Recomputed from the EMI
                    window above it is {data.breakdown.cds_score.toFixed(2)} —
                    re-run nightly scoring to refresh the stored value.
                  </p>
                )}
              </section>
            )}

            {isCds && data.reference && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Field reference
                </h3>
                <div className="space-y-3 text-xs text-gray-700">
                  <div>
                    <p className="mb-1 font-medium text-gray-800">
                      EMI weight — how each installment is scored
                    </p>
                    <table className="w-full">
                      <tbody className="divide-y divide-gray-100">
                        {data.reference.emi_weight_rules.map((r) => (
                          <tr key={r.label}>
                            <td className="py-1 pr-2">{r.label}</td>
                            <td className="py-1 pr-2 text-gray-500">
                              {r.condition}
                            </td>
                            <td className="py-1 text-right font-medium tabular-nums">
                              {r.weight.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-gray-800">
                      Recency multiplier — newest EMIs count more
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {data.reference.recency_schedule.map((r) => (
                        <span
                          key={r.position}
                          className="rounded bg-gray-100 px-1.5 py-0.5 tabular-nums text-gray-600"
                        >
                          {r.position === 0
                            ? "newest"
                            : `#${r.position + 1}`}{" "}
                          × {r.multiplier.toFixed(2)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-gray-800">
                      Streak penalty
                    </p>
                    <p className="text-gray-600">{data.reference.streak_rule}</p>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-gray-800">
                      Stale-telemetry risk
                    </p>
                    <p className="text-gray-600">
                      {data.reference.telemetry_rule}
                    </p>
                  </div>
                </div>
              </section>
            )}

            {data.confidence.reasons.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Why this confidence level
                </h3>
                <ul className="list-inside list-disc text-sm text-gray-700">
                  {data.confidence.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                When NOT to trust this score
              </h3>
              <ul className="list-inside list-disc text-sm text-gray-700">
                {data.when_not_to_trust.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>

            <section className="border-t border-gray-200 pt-4">
              <button
                type="button"
                onClick={onOverrideClick}
                disabled={!data.override.available || !onOverrideClick}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                Override score
              </button>
              <p className="mt-1 text-xs text-gray-500">
                Requires role: {data.override.required_role}
                {!data.override.available && " · override already active"}
              </p>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

export default ScoreExplainabilityDrawer;
