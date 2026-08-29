// The four numbers above the chart, and the sentence that keeps them honest.
//
// MEDIAN LEADS, AVERAGE IS DEMOTED. A handful of long calls drags the mean to a
// value no real call ever had; on production data the mean has run roughly
// double the median. Both are shown, but the sub-line on the average says why it
// is higher so nobody quotes it as "typical".
//
// THE DENOMINATOR NOTE IS NOT BOILERPLATE. Three different numbers on this
// screen legitimately disagree:
//
//   · the Completed card counts dialer_campaign_leads rows with status
//     'completed', and treats a dropped_empty silent call as a success;
//   · this panel counts calls that reached a dealer AND have a usable duration;
//   · a call can carry a transcript while its row still reads failed — see the
//     evidence-order note in lib/ai-dialer/failureReason.ts — so "connected" can
//     legitimately EXCEED "completed".
//
// Left unexplained, that reads as a bug and the whole panel loses credibility.
// So the numbers are spelled out in words, and the reader is never asked to
// subtract two figures to discover a third.
"use client";

import * as React from "react";
import type { DurationHistogramTotals } from "./types";

/**
 * Under a minute reads as seconds.
 *
 * The lead table's own fmtDuration renders 12 seconds as "0m 12s", which is the
 * wrong register for a median on a panel whose entire subject is short calls.
 */
export function fmtShort(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

/**
 * "3h 12m" | "47m 20s" | "38s" — total talk time, at the scale it lands.
 *
 * KEEPS SECONDS BELOW AN HOUR, and that is a correctness fix rather than a
 * taste one. This used to round to whole minutes while fmtShort above kept
 * seconds, so a campaign with a single 140-second call printed "2m 20s" under
 * Median and "2m" under Total talk time — two different renderings of the same
 * number, side by side, on a panel whose only job is to be believed. Hours are
 * still rounded to minutes: at that scale the seconds are noise, and no total
 * that large is being read to the second.
 */
function fmtTalkTime(seconds: number): string {
  if (seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * How many calls before a percentage means anything.
 *
 * At n=1 every share is 0% or 100%, which reads as a measured rate and is
 * actually just "the one call we have". Below this the tile prints the count
 * against its denominator instead — "0 of 1" cannot be misread as a rate.
 */
const MIN_N_FOR_PERCENT = 5;

function Tile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "neutral" | "amber" | "rose";
}) {
  const toneClass = {
    neutral: "border-gray-100 bg-gray-50/60",
    amber: "border-amber-200 bg-amber-50",
    rose: "border-rose-200 bg-rose-50",
  }[tone];
  const valueClass = {
    neutral: "text-gray-900",
    amber: "text-amber-800",
    rose: "text-rose-800",
  }[tone];

  return (
    <div className={`rounded-xl border p-4 ${toneClass}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${valueClass}`}>{value}</p>
      <p className="mt-0.5 text-[11px] text-gray-400">{sub}</p>
    </div>
  );
}

export function DurationSummaryStrip({
  totals,
  shortestLabel,
}: {
  totals: DurationHistogramTotals;
  /** Label of the first bucket, e.g. "<20s". Configurable, so never hardcoded. */
  shortestLabel: string;
}) {
  const {
    completedLeads,
    attemptedLeads,
    connectedLeads,
    bucketedConnected,
    connectedWithoutDuration,
    medianConnectedSeconds,
    averageConnectedSeconds,
    totalTalkSeconds,
    shortestBucketCount,
    shortestBucketShare,
  } = totals;

  const shortPct = Math.round(shortestBucketShare * 100);
  // Thresholds, not a gradient: the tint is a judgement ("this is bad"), and a
  // judgement needs a line drawn somewhere it can be argued about.
  // Suppressed below the percentage threshold for the same reason the number
  // is: a red tile is a claim that this campaign has a short-call problem, and
  // one call is not evidence of a rate.
  const shortTone =
    bucketedConnected < MIN_N_FOR_PERCENT
      ? "neutral"
      : shortPct >= 30
        ? "rose"
        : shortPct >= 15
          ? "amber"
          : "neutral";

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Median call"
          value={fmtShort(medianConnectedSeconds)}
          sub="the typical call"
        />
        <Tile
          label="Average call"
          value={fmtShort(averageConnectedSeconds)}
          sub="pulled up by the long tail"
        />
        <Tile
          label={`Under ${shortestLabel.replace(/^</, "")}`}
          value={String(shortestBucketCount)}
          sub={
            bucketedConnected >= MIN_N_FOR_PERCENT
              ? `${shortPct}% of measured calls`
              : `of ${bucketedConnected} measured call${bucketedConnected === 1 ? "" : "s"}`
          }
          tone={shortTone}
        />
        <Tile
          label="Total talk time"
          value={fmtTalkTime(totalTalkSeconds)}
          sub={`across ${bucketedConnected} call${bucketedConnected === 1 ? "" : "s"}`}
        />
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
        Measured on the <strong className="text-gray-600">{bucketedConnected}</strong>{" "}
        call{bucketedConnected === 1 ? "" : "s"} that reached a dealer and{" "}
        {bucketedConnected === 1 ? "has" : "have"} a recorded duration, out of{" "}
        <strong className="text-gray-600">{attemptedLeads}</strong> taken off the
        queue.
        {connectedWithoutDuration > 0 && (
          <>
            {" "}
            Another <strong className="text-gray-600">{connectedWithoutDuration}</strong>{" "}
            connected but the provider never reported a duration, so they appear in no bar.
          </>
        )}
        {connectedLeads > completedLeads && (
          <>
            {" "}
            This is more than the{" "}
            <strong className="text-gray-600">{completedLeads}</strong> shown on the Completed
            card because a call can produce a real conversation while its row is still marked
            failed.
          </>
        )}
      </p>
    </div>
  );
}
