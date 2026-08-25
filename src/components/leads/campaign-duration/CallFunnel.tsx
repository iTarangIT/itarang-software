// Where the calls go, stage by stage — and, just as importantly, what each
// stage is a share OF.
//
// THREE POPULATIONS, NEVER BLENDED. The evidence changes as you go down:
//
//   · duration and outcome exist for EVERY lead;
//   · a transcript exists for about a quarter of them;
//   · an intent score exists for about two percent.
//
// Drawn as one narrowing column, the last stage would read "2% of calls
// qualify" when the truth is "we almost never score a call". So the bars are
// grouped, each group states its own denominator in its heading, and a bar is
// only ever compared with bars in its own group. This is the same discipline as
// the duration panel's denominator paragraph: numbers on one screen are allowed
// to disagree, provided the screen says why.
//
// BARS ARE PROPORTIONAL TO THEIR OWN GROUP'S TOP, not to the campaign total, so
// a full-width bar means "everything that got this far", not "everything". Each
// bar prints its own count and share as text, which is what makes that honest
// and what keeps the section readable without relying on bar length.
"use client";

import * as React from "react";
import { Hourglass } from "lucide-react";
import type { CallQualityFunnel } from "./types";

const MIN_N_FOR_PERCENT = 5;

interface Stage {
  label: string;
  value: number;
  hint: string;
}

function StageBar({
  stage,
  denominator,
  tone,
}: {
  stage: Stage;
  denominator: number;
  tone: "slate" | "teal" | "violet";
}) {
  const share = denominator > 0 ? stage.value / denominator : 0;
  const pct = Math.round(share * 100);
  const fill = {
    slate: "bg-slate-500",
    teal: "bg-teal-600",
    violet: "bg-violet-500",
  }[tone];

  return (
    <li className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1 py-1.5">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-gray-800">{stage.label}</p>
        <p className="mt-0.5 text-[11px] text-gray-400">{stage.hint}</p>
      </div>
      <p className="shrink-0 text-right text-xs font-bold tabular-nums text-gray-900">
        {stage.value}
        {denominator >= MIN_N_FOR_PERCENT && (
          <span className="ml-1.5 font-normal text-gray-400">{pct}%</span>
        )}
      </p>
      <div
        className="col-span-2 h-1.5 overflow-hidden rounded-full bg-gray-100"
        role="presentation"
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${fill}`}
          style={{ width: `${Math.max(share * 100, stage.value > 0 ? 1.5 : 0)}%` }}
        />
      </div>
    </li>
  );
}

function Group({
  title,
  denominatorNote,
  stages,
  denominator,
  tone,
  empty,
}: {
  title: string;
  denominatorNote: string;
  stages: Stage[];
  denominator: number;
  tone: "slate" | "teal" | "violet";
  empty?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
          {title}
        </h4>
        <p className="text-[11px] text-gray-400">{denominatorNote}</p>
      </div>
      {denominator === 0 && empty ? (
        <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2.5 text-[11px] text-gray-400">
          {empty}
        </p>
      ) : (
        <ul>
          {stages.map((s) => (
            <StageBar key={s.label} stage={s} denominator={denominator} tone={tone} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function CallFunnel({ funnel }: { funnel: CallQualityFunnel }) {
  const f = funnel;
  const neverPlaced = f.attempted - f.dialled;

  return (
    <div className="space-y-5">
      <Group
        title="Every call we tried"
        denominatorNote={`of ${f.attempted} taken off the queue`}
        denominator={f.attempted}
        tone="slate"
        empty="No lead has been taken off the queue yet."
        stages={[
          {
            label: "Actually placed",
            value: f.dialled,
            hint: "the provider reached the phone network",
          },
          {
            label: "Answered",
            value: f.answered,
            hint: "a dealer picked up — talk time or a transcript proves it",
          },
        ]}
      />

      {/* Our own failures are not a funnel stage, they are a defect count, and
          burying them inside "not dialled" is how a misconfiguration outage
          reads as poor dealer engagement for a week. */}
      {neverPlaced > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          <strong>{neverPlaced}</strong> attempt{neverPlaced === 1 ? "" : "s"} never
          reached the network at all — the provider rejected the trigger, or we
          skipped the lead. No phone rang, so these say nothing about the dealers.
          The Failed tab names the reason for each.
        </p>
      )}

      <Group
        title="What happened on the call"
        denominatorNote={`of ${f.withTranscript} with a transcript`}
        denominator={f.withTranscript}
        tone="teal"
        empty="No transcript was stored for this campaign, so the conversation stages cannot be measured. Calls before the ElevenLabs migration did not store one."
        stages={[
          {
            label: "Dealer said something",
            value: f.dealerSpoke,
            hint: "at least one reply from the dealer",
          },
          {
            label: "Got past the opening line",
            value: f.pastOpener,
            hint: "the AI reached a second turn",
          },
          {
            label: "Real conversation",
            value: f.meaningfulConversation,
            hint: "three or more dealer replies",
          },
        ]}
      />

      {/* HOW LONG A CONVERSATION RUNS, kept apart from how long a CALL runs.
          The duration strip below already shows "Average call" — a mean over
          every measured call, which on live data is 32s because it blends 52s
          conversations with 9s calls nobody answered. Both are true; only one
          answers "how long do our conversations last". Shown side by side with
          the silent side named, so neither can be mistaken for the other. */}
      {f.conversation.measured > 0 && (
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
              How long a real conversation lasts
            </h4>
            <p className="text-[11px] text-gray-400">
              of {f.conversation.measured} the dealer spoke on
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-teal-100 bg-teal-50/60 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
                Median conversation
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-teal-900">
                {f.conversation.medianSeconds}s
              </p>
              <p className="mt-0.5 text-[11px] text-gray-400">the typical exchange</p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
                Average conversation
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900">
                {f.conversation.averageSeconds}s
              </p>
              <p className="mt-0.5 text-[11px] text-gray-400">
                pulled up by the long tail
              </p>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
            Measured only on calls the dealer actually spoke on. The
            &ldquo;Average call&rdquo; figure further down is a different
            number on purpose — it includes the{" "}
            {f.withTranscript - f.dealerSpoke} call
            {f.withTranscript - f.dealerSpoke === 1 ? "" : "s"} where nobody
            answered, which drags it well below the length of a real exchange.
          </p>
        </div>
      )}

      {/* A METRIC THAT IS NOT MEASURABLE YET, SAID OUT LOUD.
          "How long did the dealer wait before hanging up" needs per-turn
          timings. ElevenLabs sends them on every turn and we discarded them at
          the stringify step until E-267, so no historical call can ever answer
          this — the data is gone, not merely missing. Rendering "0s" or hiding
          the row would both read as an answer. An empty state that names the
          reason is the only honest option, and it is also the only thing that
          tells someone the number is coming. */}
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
            Time on the line before hanging up
          </h4>
          <p className="text-[11px] text-gray-400">
            {f.responseTime.measured > 0
              ? `of ${f.responseTime.measured} measured`
              : "not yet measurable"}
          </p>
        </div>
        {f.responseTime.measured > 0 ? (
          <p className="text-xs text-gray-800">
            <span className="text-lg font-bold tabular-nums text-gray-900">
              {f.responseTime.medianSecondsBeforeHangUp}s
            </span>{" "}
            <span className="text-gray-500">
              median between the AI finishing and the dealer dropping, across{" "}
              {f.responseTime.measured} call
              {f.responseTime.measured === 1 ? "" : "s"} nobody answered
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-1.5 rounded-lg border border-dashed border-gray-200 px-3 py-2.5 text-[11px] leading-relaxed text-gray-400">
            <Hourglass className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
              Collecting. This needs the timing of each turn, which the provider
              sends and we discarded before storing until now — so no past call
              can answer it, however far back you look. It appears once calls
              placed after the change accumulate.
            </span>
          </p>
        )}
      </div>

      <Group
        title="Qualification"
        denominatorNote={`of ${f.scored} scored`}
        denominator={f.scored}
        tone="violet"
        empty="No call in this campaign has been scored for intent yet, so qualification cannot be measured. This is a gap in our scoring, not a signal about the dealers."
        stages={[
          {
            label: "Qualified",
            value: f.qualified,
            hint: "three or more facts disclosed",
          },
        ]}
      />
    </div>
  );
}
