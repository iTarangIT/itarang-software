"use client";

import { useEffect } from "react";
import type { CardForUi } from "./SeverityTabs";
import { SEVERITY_COLOR_TOKENS, SEVERITY_LABELS } from "@/lib/risk/severity";

export default function RiskCardDrawer({
  card,
  onClose,
}: {
  card: CardForUi;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tone = SEVERITY_COLOR_TOKENS[card.severity];
  const sample = card.evidence?.sample_rows ?? [];
  const notes = card.evidence?.notes ?? [];

  return (
    <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose}>
      <div
        className="absolute right-0 top-0 bottom-0 w-full md:w-[640px] bg-white dark:bg-slate-950 shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 p-5 flex items-start gap-4">
          <div className="flex-1">
            <div
              className={`inline-block text-xs font-semibold uppercase px-2 py-0.5 rounded ${tone.bg} ${tone.fg}`}
            >
              {SEVERITY_LABELS[card.severity]}
            </div>
            <h2 className="mt-2 text-lg font-semibold">{card.title}</h2>
            <p className="text-sm text-slate-500 mt-1">{card.finding_summary}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-900 px-2 py-1"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-6">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Hypothesis
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
              {card.description}
            </p>
          </section>

          <section className="grid grid-cols-3 gap-3">
            <Stat label="Affected" value={card.affected_count.toLocaleString("en-IN")} />
            <Stat label="Total" value={card.total_count.toLocaleString("en-IN")} />
            <Stat
              label="Share"
              value={
                card.total_count > 0
                  ? ((100 * card.affected_count) / card.total_count).toFixed(1) + "%"
                  : "—"
              }
            />
          </section>

          {sample.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Sample evidence ({sample.length})
              </h3>
              <div className="mt-2 overflow-x-auto rounded border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900 text-xs text-slate-500 uppercase">
                    <tr>
                      {Object.keys(sample[0] ?? {}).map((k) => (
                        <th key={k} className="px-3 py-2 text-left font-medium">
                          {k}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sample.map((row, i) => (
                      <tr
                        key={i}
                        className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/50"
                      >
                        {Object.values(row).map((v, j) => (
                          <td key={j} className="px-3 py-1.5 tabular-nums">
                            {fmtCell(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {notes.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Methodology notes
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-400 list-disc pl-5">
                {notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="text-xs text-slate-500">
            {card.run_at ? (
              <>Last computed {new Date(card.run_at).toLocaleString()}</>
            ) : (
              <>Live computation — not yet persisted to risk_card_runs.</>
            )}
            {" · "}
            Source: {card.source}
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-base font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function fmtCell(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
