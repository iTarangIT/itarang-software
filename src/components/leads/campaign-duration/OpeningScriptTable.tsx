// Which opening line keeps dealers on the phone.
//
// This is the closest thing the panel has to an experiment, so it is presented
// with its uncertainty attached rather than as a verdict. On the data that
// exists today the top opener carries n=10 against n=69 for the incumbent — a
// large effect on a small sample, which is worth SEEING and not yet worth
// betting the campaign on. Percentages below MIN_N_FOR_PERCENT are suppressed
// entirely: at n=2 every rate is 0%, 50% or 100%, and those read as measured
// rates when they are just "the two calls we have".
//
// WHY THE OPENING WORDS AND NOT agent_id. The obvious key is the provider's
// agent id, and it does not work: it is populated on 206 rows and on ZERO of the
// rows that have a transcript, so the two can never be joined. The opening words
// are also the better key on the merits — they are what the dealer actually
// heard, and two agents reading the same script should not look like two
// experiments.
//
// The fingerprint is shown as WORDS, not a hash, for the same reason: whoever
// reads this table has to recognise the line to act on it.
//
// TRUNCATION IS NOT SCRIPT IDENTITY. A script whose calls keep dropping early
// would, under a longer fingerprint, split into several "variants" each looking
// differently effective — the key would be measuring where the audio stopped.
// call-quality/transcript.ts keeps the key short for exactly this reason, and
// the "played in full" column carries the truncation instead.
"use client";

import * as React from "react";
import { MessageSquareQuote } from "lucide-react";
import type { OpeningScriptStat } from "./types";

const MIN_N_FOR_PERCENT = 5;

function rate(n: number, d: number): string {
  if (d < MIN_N_FOR_PERCENT) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export function OpeningScriptTable({ scripts }: { scripts: OpeningScriptStat[] }) {
  if (scripts.length === 0) return null;

  const total = scripts.reduce((s, x) => s + x.calls, 0);
  const comparable = scripts.filter((s) => s.calls >= MIN_N_FOR_PERCENT).length;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <MessageSquareQuote className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
        <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
          Opening lines
        </h4>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] border-collapse text-left">
          <caption className="sr-only">
            Opening lines used in this campaign, with how often the dealer replied
            to each.
          </caption>
          <thead>
            <tr className="border-b border-gray-200">
              <th scope="col" className="pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                First thing the dealer hears
              </th>
              <th scope="col" className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Calls
              </th>
              <th scope="col" className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Played in full
              </th>
              <th scope="col" className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Dealer replied
              </th>
              <th scope="col" className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Avg length
              </th>
            </tr>
          </thead>
          <tbody>
            {scripts.map((s) => {
              const thin = s.calls < MIN_N_FOR_PERCENT;
              return (
                <tr key={s.fingerprint} className="border-b border-gray-100 last:border-0">
                  <td className="py-2 pr-3">
                    <span
                      className={`text-xs ${thin ? "text-gray-400" : "text-gray-800"}`}
                      lang="hi"
                    >
                      {s.fingerprint}…
                    </span>
                  </td>
                  <td className="py-2 text-right text-xs tabular-nums text-gray-700">
                    {s.calls}
                  </td>
                  <td className="py-2 text-right text-xs tabular-nums text-gray-500">
                    {rate(s.greetingCompleted, s.calls)}
                  </td>
                  <td
                    className={`py-2 text-right text-xs font-semibold tabular-nums ${
                      thin ? "text-gray-400" : "text-gray-900"
                    }`}
                  >
                    {rate(s.dealerSpoke, s.calls)}
                  </td>
                  <td className="py-2 text-right text-xs tabular-nums text-gray-500">
                    {s.averageSeconds != null ? `${s.averageSeconds}s` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
        Grouped by the AI&apos;s first words, across the {total} call
        {total === 1 ? "" : "s"} with a transcript.{" "}
        {comparable < 2 ? (
          <>
            Only {comparable === 1 ? "one line has" : "no line has"} enough calls to
            compare yet — rates appear once a line reaches {MIN_N_FOR_PERCENT}.
          </>
        ) : (
          <>
            Rates are hidden below {MIN_N_FOR_PERCENT} calls. Treat these as a
            direction to test, not a finished result — the samples are small and
            nothing here controls for who was called or when.
          </>
        )}
      </p>
    </div>
  );
}
