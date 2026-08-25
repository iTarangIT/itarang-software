// The finding that goes first, because it is the one that changes what you do.
//
// Across the stored transcripts, fifty-one of eighty-three are a single turn —
// the AI speaks, the dealer never does — and forty-four of those fifty-one were
// CUT OFF mid-sentence at a median of seven seconds. That is not dealers
// rejecting the pitch. That is the pitch not arriving.
//
// A funnel phrased as "% reaching the first question" reports this as one low
// percentage among six, which reads as "our script is weak" and sends someone
// off to rewrite the wrong thing. So it is lifted out and stated in words.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM. The transcript proves the greeting
// stopped; it does not prove WHO stopped it. A dealer hanging up and a line
// dropping produce the same truncated text. The heading says "did not finish",
// never "the dealer hung up", and the body names both possibilities. Getting
// this wrong would point the team at the script when the problem is telephony —
// the same class of error as the wall-clock durations this panel used to show.
//
// The tone is a JUDGEMENT and needs a line drawn somewhere it can be argued
// about, so it is a threshold rather than a gradient — the same rule the
// duration summary strip applies to its short-call tile.
"use client";

import * as React from "react";
import { PhoneOff } from "lucide-react";
import type { CallQualityFunnel } from "./types";

/** Below this, a share is "the handful of calls we have", not a rate. */
const MIN_N_FOR_PERCENT = 5;

export function GreetingCliff({ funnel }: { funnel: CallQualityFunnel }) {
  const { withTranscript, greeting } = funnel;

  // Nothing to diagnose without transcripts. Silence beats a row of zeroes,
  // which would read as "every greeting landed".
  if (withTranscript === 0) return null;

  const cliff = greeting.cutOffBeforeDealerSpoke;
  if (cliff === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3">
        <p className="text-xs font-semibold text-emerald-900">
          Every greeting reached the dealer.
        </p>
        <p className="mt-0.5 text-[11px] text-emerald-800/80">
          No call in this campaign ended inside the opening line.
        </p>
      </div>
    );
  }

  const pct = Math.round((cliff / withTranscript) * 100);
  const showPct = withTranscript >= MIN_N_FOR_PERCENT;
  const severe = showPct && pct >= 30;

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        severe ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <PhoneOff
          className={`mt-0.5 h-4 w-4 shrink-0 ${severe ? "text-rose-600" : "text-amber-600"}`}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p
            className={`text-xs font-bold ${severe ? "text-rose-900" : "text-amber-900"}`}
          >
            {showPct ? (
              <>
                {pct}% of connected calls end before the greeting finishes
              </>
            ) : (
              <>
                {cliff} of {withTranscript} connected call
                {withTranscript === 1 ? "" : "s"} ended before the greeting finished
              </>
            )}
          </p>
          <p
            className={`mt-1 text-[11px] leading-relaxed ${
              severe ? "text-rose-800/85" : "text-amber-800/85"
            }`}
          >
            On <strong>{cliff}</strong> call{cliff === 1 ? "" : "s"} the AI&apos;s opening
            sentence stops mid-way and the dealer never says a word
            {greeting.medianCutOffSeconds != null && (
              <> — a median of {greeting.medianCutOffSeconds} seconds in</>
            )}
            . The dealer may be hanging up, or the line may be dropping; the
            transcript shows only that the sentence did not finish. Either way the
            pitch is not being heard, so the script&apos;s wording is not what is
            costing these calls.
          </p>
          {/* THE TWO SILENCES, KEPT APART. A dealer cut off mid-sentence never
              heard the offer — that is telephony. A dealer who heard the whole
              thing and still said nothing rejected what they heard — that is
              the script. Merging them into one "did not engage" figure is what
              would send someone to rewrite a script that is not being played;
              on live data the split is 44 against 7. */}
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-white/60 px-2.5 py-1.5">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Never heard the offer
              </dt>
              <dd className="mt-0.5 text-sm font-bold tabular-nums text-gray-900">
                {cliff}
                <span className="ml-1.5 text-[10px] font-normal text-gray-500">
                  cut off mid-greeting
                </span>
              </dd>
            </div>
            <div className="rounded-lg bg-white/60 px-2.5 py-1.5">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Heard it, said nothing
              </dt>
              <dd className="mt-0.5 text-sm font-bold tabular-nums text-gray-900">
                {greeting.completeThenSilent}
                <span className="ml-1.5 text-[10px] font-normal text-gray-500">
                  the script&apos;s own result
                </span>
              </dd>
            </div>
          </dl>

          <p className="mt-1.5 text-[11px] text-gray-500">
            {greeting.complete} greeting{greeting.complete === 1 ? "" : "s"} played in
            full · {greeting.cutOff} cut off · measured on the {withTranscript} call
            {withTranscript === 1 ? "" : "s"} with a stored transcript.
          </p>
        </div>
      </div>
    </div>
  );
}
