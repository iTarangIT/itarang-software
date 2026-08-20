// The call-duration histogram: how many calls fell in each duration band.
//
//   0-20s | 20-40s | 40-60s | 60-120s | 120-300s | 300s+
//
// One question, one chart. Duration on the x-axis, number of calls on the y —
// the canonical histogram shape, so the distribution is read from the skyline
// rather than from a column of numbers.
//
// SINGLE SERIES, SO NO LEGEND. Every bar is the same measure (a count of
// calls), so there is nothing to distinguish by colour and a legend box would
// only add furniture. The heading names the measure; the value sits on each bar.
//
// BARS SCALE TO THE TALLEST BUCKET, not to the total, so a full-height bar means
// "the mode". That is only honest because every bar prints its own count as
// text — which is also what keeps the chart readable for anyone who cannot rely
// on the fill colour.
//
// THE BARS TOUCH, AND THAT IS THE POINT. Contiguous bars are what make this a
// histogram rather than a bar chart: the x-axis is a continuous quantity cut
// into adjacent bins, so 20-40s literally begins where 0-20s ends and a gap
// between them would imply a range with no data in it. Adjacent fills are
// separated by a hairline border instead of by empty space — same job, correct
// idiom. Tops are square for the same reason: a rounded cap reads as a
// discrete category marker.
//
// CSS BARS, NOT RECHARTS — a functional decision, not a taste one. Clicking a
// bar filters the lead table below, and a recharts <Bar> renders as an SVG
// <path> with no tabindex, no role and no key handling, so keyboard operation
// would have to be hand-rolled onto SVG elements. Here each bar IS a
// <button aria-pressed>, so keyboard, focus and state announcement come for
// free, and the counts are real text rather than SVG.
"use client";

import * as React from "react";
import type { DurationHistogramBucket } from "./types";

/** Plot height in px. Tall enough to tell 18 from 15 at a glance without the
 *  panel needing its own scroll. */
const PLOT_H = 150;

/** A bucket with zero calls still gets a visible stub, so the reader sees a
 *  measured zero rather than a gap where a bar should be. */
const EMPTY_STUB_PX = 2;

export function DurationHistogram({
  buckets,
  bucketedConnected,
  selected,
  onSelect,
}: {
  buckets: DurationHistogramBucket[];
  bucketedConnected: number;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Number of calls
        </p>
        <p className="text-[11px] text-gray-400">
          {bucketedConnected} measured call{bucketedConnected === 1 ? "" : "s"}
        </p>
      </div>

      <ul className="flex items-end" style={{ height: PLOT_H }}>
        {buckets.map((b) => {
          const isSelected = selected === b.key;
          const h = b.count > 0 ? Math.max(4, (b.count / max) * (PLOT_H - 24)) : EMPTY_STUB_PX;

          return (
            <li key={b.key} className="flex h-full min-w-0 flex-1 flex-col justify-end">
              <button
                type="button"
                onClick={() => onSelect(b.key)}
                aria-pressed={isSelected}
                // cursor-pointer is required, not decorative: Tailwind v4's
                // preflight resets button { cursor: default }.
                className="group flex w-full cursor-pointer flex-col justify-end focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
              >
                {/* The value, above its bar. With six bars there is room to
                    label every one, which removes the need to read heights
                    against a y-axis at all. */}
                <span
                  className={`mb-1 block text-center text-sm font-bold tabular-nums ${
                    b.count > 0 ? "text-gray-900" : "text-gray-300"
                  }`}
                >
                  {b.count}
                </span>
                <span
                  className={`block w-full border transition-all duration-300 ${
                    // An empty bucket's stub is GREY, not a sliver of the series
                    // colour: in the series colour it sits on the axis and reads
                    // as a filled bar of one call, the opposite of the zero it
                    // represents.
                    b.count === 0
                      ? "border-gray-300 bg-gray-200"
                      : isSelected
                        ? "border-teal-900 bg-teal-700"
                        : selected
                          ? "border-teal-800/30 bg-teal-600/30 group-hover:bg-teal-600/50"
                          : "border-teal-800 bg-teal-600 group-hover:bg-teal-700"
                  }`}
                  style={{ height: h }}
                />
                <span className="sr-only">
                  {b.aria}: {b.count} of {bucketedConnected} measured calls.
                  {isSelected
                    ? " Selected. The lead table below is filtered to these calls."
                    : " Activate to filter the lead table below to these calls."}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* The x-axis: one label per bucket, sharing the same flex geometry as
          the bars above so a label always sits under its own column. */}
      <ul className="flex border-t border-gray-300 pt-1.5">
        {buckets.map((b) => (
          <li
            key={b.key}
            className={`min-w-0 flex-1 text-center text-[11px] tabular-nums ${
              selected === b.key ? "font-semibold text-gray-900" : "text-gray-500"
            }`}
          >
            {b.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
