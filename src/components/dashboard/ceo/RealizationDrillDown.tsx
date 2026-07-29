"use client";

/**
 * E-219 — what the Realization card opens.
 *
 * Four figures, the arithmetic between them shown rather than implied, and a
 * way into the row-level list behind each. It deliberately does NOT re-fetch:
 * the numbers are the same objects the card was rendered from, so the modal can
 * never show a total that disagrees with the card that was clicked.
 *
 * The row lists live in DrillDownModal, which is a table component. Rather than
 * bend it into a summary panel, each line here hands off to it for the metric
 * it names.
 */

import React from "react";
import { Modal } from "@/components/leads/lead-v2-modals";
import { formatINRExact } from "@/lib/format";
import { ArrowRight } from "lucide-react";
import type { DrillMetric } from "./DrillDownModal";
import type { CeoOverviewData } from "./CeoOverviewCards";

interface Line {
  label: string;
  hint: string;
  value: number;
  /** Which row-level drill-down this line opens, if any. */
  metric?: DrillMetric;
  /** Rendered with a leading minus to show it being taken off revenue. */
  negate?: boolean;
}

export function RealizationDrillDown({
  data,
  windowLabel,
  onOpenMetric,
  onClose,
}: {
  data: CeoOverviewData["realization"];
  windowLabel: string;
  onOpenMetric: (metric: DrillMetric, title: string) => void;
  onClose: () => void;
}) {
  const lines: Line[] = [
    {
      label: "Total Revenue",
      hint: "Invoiced in this period, excluding void",
      value: data.revenue,
      metric: "sales",
    },
    {
      label: "Total Expense",
      hint: "Approved expense submissions, by invoice date",
      value: data.expense,
      metric: "expenses",
      negate: true,
    },
  ];

  return (
    <Modal isOpen onClose={onClose} title={`Realization · ${windowLabel}`} size="lg">
      <div className="space-y-1">
        {lines.map((line) => (
          <button
            key={line.label}
            type="button"
            onClick={() =>
              line.metric && onOpenMetric(line.metric, `${line.label} · ${windowLabel}`)
            }
            disabled={!line.metric}
            className="w-full flex items-center justify-between gap-4 p-4 rounded-xl border border-gray-100 bg-gray-50/60 text-left transition-colors enabled:hover:bg-white enabled:hover:border-brand-100 disabled:cursor-default"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900">{line.label}</p>
              <p className="text-xs text-gray-500 mt-0.5">{line.hint}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-sm font-bold tabular-nums text-gray-900">
                {line.negate ? "− " : ""}
                {formatINRExact(line.value)}
              </span>
              {line.metric && <ArrowRight className="w-3.5 h-3.5 text-gray-400" />}
            </div>
          </button>
        ))}

        <div className="flex items-center justify-between gap-4 p-4 rounded-xl bg-brand-50 border border-brand-100 mt-2">
          <div className="min-w-0">
            <p className="text-sm font-bold text-brand-900">Realization</p>
            <p className="text-xs text-brand-700/70 mt-0.5">Revenue − expense</p>
          </div>
          <span className="text-lg font-bold tabular-nums text-brand-900 shrink-0">
            {formatINRExact(data.realization)}
          </span>
        </div>

        {/* Outstanding sits below the total, not inside it. It is money already
            counted as revenue that has not been collected — context for reading
            the realization figure, not a term in it. */}
        <button
          type="button"
          onClick={() => onOpenMetric("outstanding", "Outstanding Credits")}
          className="w-full flex items-center justify-between gap-4 p-4 rounded-xl border border-amber-100 bg-amber-50/60 text-left transition-colors hover:bg-amber-50 mt-4"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-900">Outstanding Credits</p>
            <p className="text-xs text-amber-700/80 mt-0.5">
              Unpaid balances on invoices raised in this period — already counted in
              revenue above, not yet collected
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-sm font-bold tabular-nums text-amber-900">
              {formatINRExact(data.outstanding)}
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-amber-500" />
          </div>
        </button>
      </div>
    </Modal>
  );
}
