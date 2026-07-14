"use client";

import { useMemo, useState } from "react";
import {
  TAB_LABELS,
  TAB_ORDER,
  severityRank,
  tabFor,
  type Severity,
  type SeverityTab,
  type VerdictSource,
} from "@/lib/risk/severity";
import RiskCard from "./RiskCard";
import RiskCardDrawer from "./RiskCardDrawer";

export interface CardForUi {
  slug: string;
  hypothesis_id: string;
  title: string;
  description: string;
  source: string;
  /** E-188 — vetted by a human. Unpromoted agent hypotheses are capped at warn. */
  promoted: boolean;
  severity: Severity;
  verdict_source: VerdictSource;
  finding_summary: string;
  affected_count: number;
  total_count: number;
  evidence: {
    sample_rows?: Array<Record<string, unknown>>;
    chart?: { kind: string; data: unknown };
    notes?: string[];
    thresholds?: Record<string, number>;
    severity_capped?: boolean;
  };
  critique: string | null;
  run_at: string | null;
}

/** Show more than the old hard 20 before we truncate, and say so when we do. */
const PAGE_SIZE = 24;

export default function SeverityTabs({ cards }: { cards: CardForUi[] }) {
  const [active, setActive] = useState<SeverityTab>("high");
  const [expanded, setExpanded] = useState(false);
  const [openCard, setOpenCard] = useState<CardForUi | null>(null);

  const counts = useMemo(() => {
    const c: Record<SeverityTab, number> = { high: 0, warn: 0, inconclusive: 0, ok: 0 };
    for (const card of cards) c[tabFor(card.severity)]++;
    return c;
  }, [cards]);

  const inTab = useMemo(
    () =>
      cards
        .filter((c) => tabFor(c.severity) === active)
        .sort(
          (a, b) =>
            severityRank(a.severity) - severityRank(b.severity) ||
            b.affected_count - a.affected_count,
        ),
    [cards, active],
  );
  const visible = expanded ? inTab : inTab.slice(0, PAGE_SIZE);
  const hidden = inTab.length - visible.length;

  return (
    <div>
      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-800">
        {TAB_ORDER.map((tab) => {
          const isActive = active === tab;
          const tone =
            tab === "high"
              ? "text-red-600 border-red-500"
              : tab === "warn"
                ? "text-amber-600 border-amber-500"
                : tab === "inconclusive"
                  ? "text-slate-700 dark:text-slate-300 border-slate-500"
                  : "text-emerald-600 border-emerald-500";
          return (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setActive(tab);
                setExpanded(false);
              }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                isActive ? tone : "text-slate-500 border-transparent hover:text-slate-900"
              }`}
            >
              {TAB_LABELS[tab]}
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700">
                {counts[tab]}
              </span>
            </button>
          );
        })}
      </div>

      {active === "inconclusive" && inTab.length > 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          These hypotheses did not produce a verdict — the test could not run, or blew up. They are
          not statements about the portfolio.
        </p>
      ) : null}

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

      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-4 text-sm text-slate-600 dark:text-slate-400 underline underline-offset-4 hover:text-slate-900"
        >
          Show {hidden} more card{hidden === 1 ? "" : "s"} in this bucket
        </button>
      ) : null}

      {openCard && <RiskCardDrawer card={openCard} onClose={() => setOpenCard(null)} />}
    </div>
  );
}
