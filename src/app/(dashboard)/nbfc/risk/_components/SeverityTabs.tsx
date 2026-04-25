"use client";

import { useMemo, useState } from "react";
import { SEVERITIES, SEVERITY_LABELS, severityRank } from "@/lib/risk/severity";
import RiskCard from "./RiskCard";
import RiskCardDrawer from "./RiskCardDrawer";

import type { Severity } from "@/lib/risk/hand-coded-cards";

export interface CardForUi {
  slug: string;
  hypothesis_id: string;
  title: string;
  description: string;
  source: string;
  severity: Severity;
  finding_summary: string;
  affected_count: number;
  total_count: number;
  evidence: {
    sample_rows?: Array<Record<string, unknown>>;
    chart?: { kind: string; data: unknown };
    notes?: string[];
  };
  run_at: string | null;
}

const TAB_ORDER: Severity[] = ["high", "warn", "ok"];

export default function SeverityTabs({ cards }: { cards: CardForUi[] }) {
  const [active, setActive] = useState<Severity>("high");
  const [openCard, setOpenCard] = useState<CardForUi | null>(null);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { high: 0, warn: 0, ok: 0 };
    for (const card of cards) c[card.severity]++;
    return c;
  }, [cards]);

  const visible = useMemo(
    () =>
      cards
        .filter((c) => c.severity === active)
        .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.affected_count - a.affected_count)
        .slice(0, 20),
    [cards, active],
  );

  return (
    <div>
      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-800">
        {TAB_ORDER.map((sev) => {
          const isActive = active === sev;
          const tone =
            sev === "high"
              ? "text-red-600 border-red-500"
              : sev === "warn"
                ? "text-amber-600 border-amber-500"
                : "text-emerald-600 border-emerald-500";
          return (
            <button
              key={sev}
              type="button"
              onClick={() => setActive(sev)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                isActive ? tone : "text-slate-500 border-transparent hover:text-slate-900"
              }`}
            >
              {SEVERITY_LABELS[sev]}
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700">
                {counts[sev]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.length === 0 ? (
          <div className="col-span-full text-center text-sm text-slate-500 py-12 border border-dashed border-slate-300 rounded-lg">
            No cards in this bucket. Try another tab.
          </div>
        ) : (
          visible.map((card) => (
            <RiskCard key={card.hypothesis_id} card={card} onOpen={() => setOpenCard(card)} />
          ))
        )}
      </div>

      {openCard && <RiskCardDrawer card={openCard} onClose={() => setOpenCard(null)} />}
    </div>
  );
}
