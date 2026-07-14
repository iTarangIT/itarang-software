"use client";

import type { CardForUi } from "./SeverityTabs";
import { SEVERITY_COLOR_TOKENS, SEVERITY_LABELS, isComputed } from "@/lib/risk/severity";

export default function RiskCard({ card, onOpen }: { card: CardForUi; onOpen: () => void }) {
  const tone = SEVERITY_COLOR_TOKENS[card.severity];
  const computed = isComputed(card.verdict_source);
  const pct = card.total_count > 0 ? (100 * card.affected_count) / card.total_count : 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 hover:ring-2 ${tone.ring} transition`}
    >
      <div className="flex items-start gap-2 flex-wrap">
        <div className={`text-xs font-semibold uppercase px-2 py-0.5 rounded ${tone.bg} ${tone.fg}`}>
          {SEVERITY_LABELS[card.severity]}
        </div>
        {card.source !== "human" && (
          <span className="text-xs text-slate-500 px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
            AI
          </span>
        )}
        {card.verdict_source === "legacy_llm" && (
          <span className="text-xs font-medium px-2 py-0.5 rounded bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-400">
            Unverified
          </span>
        )}
      </div>

      <h3 className="mt-3 text-base font-semibold leading-snug">{card.title}</h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 line-clamp-2">
        {card.finding_summary}
      </p>

      {/* A count nobody computed is not a measurement — don't render it as one.
          The old card showed "0 / 0 affected" with a full-width green bar for
          every failed evaluation. */}
      {computed ? (
        <>
          <div className="mt-4 flex items-baseline gap-2">
            <span className={`text-2xl font-semibold ${tone.fg}`}>
              {card.affected_count.toLocaleString("en-IN")}
            </span>
            <span className="text-sm text-slate-500">
              / {card.total_count.toLocaleString("en-IN")} affected
            </span>
          </div>
          <div className="mt-2 h-1 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
            <div className={`${tone.bar} h-full`} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        </>
      ) : (
        <div className="mt-4 text-sm text-slate-500 italic">No verdict computed</div>
      )}
    </button>
  );
}
