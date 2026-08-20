// Once a bar is selected, exactly what happened to the calls inside it.
//
// This is where the panel earns its keep. A bar saying 31 calls died inside
// twenty seconds is a symptom; "18 of them were no-response, 9 were silent" is
// the diagnosis, and the two point at completely different fixes — a telephony
// problem versus an opening-line problem.
//
// NO STANDING COLOUR KEY. There used to be a five-swatch legend here, from when
// each bar was stacked by outcome. The bars are a single series now, so a colour
// key would map its swatches to nothing on screen — a legend for a chart that
// no longer exists. The family colour instead rides on each row of the
// breakdown, where it sits directly beside the label it belongs to and colour is
// never the only channel carrying meaning.
//
// Reason names come from lib/ai-dialer/failureReason via the endpoint, so a row
// here and a chip in the lead table cannot disagree about the same call.
"use client";

import * as React from "react";
import { AlertTriangle, MousePointerClick } from "lucide-react";
import { OUTCOME_FAMILIES_BY_KEY } from "@/lib/ai-dialer/call-duration/outcomeFamilies";
import type { DurationHistogramBucket } from "./types";

export function BucketOutcomeLegend({
  buckets,
  selected,
  onClear,
}: {
  buckets: DurationHistogramBucket[];
  selected: string | null;
  onClear: () => void;
}) {
  const bucket = selected ? buckets.find((b) => b.key === selected) : null;

  // Without this the bars give no sign they are clickable, and the most useful
  // half of the panel stays hidden behind an affordance nobody found.
  if (!bucket) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
        <MousePointerClick className="h-3 w-3 shrink-0" />
        Select a bar to see why those calls ended, and to filter the table below
        to them.
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-bold text-gray-900">
          {bucket.count} call{bucket.count === 1 ? "" : "s"} in {bucket.label}
          {bucket.medianSeconds != null && (
            <span className="font-normal text-gray-500">
              {" "}
              · median {bucket.medianSeconds}s
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 cursor-pointer text-[11px] font-semibold text-emerald-700 underline hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          Clear
        </button>
      </div>

      {bucket.outcomes.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-gray-500">
          No calls landed in this bucket.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {bucket.outcomes.map((o) => (
            <li key={o.code} className="flex items-start gap-2 text-[11px]">
              <span className="w-7 shrink-0 text-right font-bold tabular-nums text-gray-900">
                {o.count}
              </span>
              <span
                className="mt-1 h-2 w-2 shrink-0 rounded-sm"
                style={{
                  backgroundColor: OUTCOME_FAMILIES_BY_KEY[o.family]?.color,
                }}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="font-semibold text-gray-800">{o.label}</span>
                {o.ourFault && (
                  // A misconfigured dialer says nothing about the dealer and
                  // everything about us. It should never sit unremarked in a
                  // list of dealer behaviours.
                  <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    our side
                  </span>
                )}
                <span className="block text-gray-500">{o.hint}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
