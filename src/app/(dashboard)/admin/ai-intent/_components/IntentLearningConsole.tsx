"use client";

// The curator's workspace: how well is the model doing, where is it wrong, and
// what should it be taught next.
//
// Three panels, in the order the work actually happens:
//   1. Scoreboard      — is agreement improving?
//   2. Disagreements   — the specific calls it read wrong. Promote from here.
//   3. Active examples — what the prompt currently teaches. Reversible.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  Check,
  GraduationCap,
  Loader2,
  Power,
  TrendingUp,
} from "lucide-react";

interface Accuracy {
  windowDays: number;
  total: number;
  agreed: number;
  disagreed: number;
  agreementRate: number | null;
  appliedToLead: number;
  confusion: { aiBand: string | null; humanStatus: string; count: number }[];
  reviewers: { role: string; count: number }[];
  activeExampleCount: number;
}

interface Disagreement {
  id: string;
  callId: string;
  leadId: string | null;
  leadName: string | null;
  aiBand: string | null;
  aiScore: number | null;
  humanStatus: string;
  correctedSignals: unknown;
  note: string | null;
  reviewerName: string | null;
  reviewerRole: string | null;
  createdAt: string | null;
  transcript: string | null;
  alreadyPromoted: boolean;
}

interface Example {
  id: string;
  why: string;
  transcript: string;
  signals: unknown;
  active: boolean;
  sortOrder: number;
  sourceCallId: string | null;
  createdAt: string | null;
  createdByName: string | null;
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  const json = await res.json();
  return json?.success ? (json.data as T) : null;
}

export function IntentLearningConsole() {
  const qc = useQueryClient();
  const [promoting, setPromoting] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: accuracy } = useQuery({
    queryKey: ["intent-accuracy"],
    queryFn: () => getJson<Accuracy>("/api/admin/intent-learning/accuracy"),
  });

  const { data: disagreements, isLoading: loadingDis } = useQuery({
    queryKey: ["intent-disagreements"],
    queryFn: async () =>
      (await getJson<{ disagreements: Disagreement[] }>(
        "/api/admin/intent-learning/disagreements",
      ))?.disagreements ?? [],
  });

  const { data: examples } = useQuery({
    queryKey: ["intent-examples"],
    queryFn: async () =>
      (await getJson<{ examples: Example[] }>("/api/admin/intent-learning/examples"))
        ?.examples ?? [],
  });

  const promote = useMutation({
    mutationFn: async (d: Disagreement) => {
      const res = await fetch("/api/admin/intent-learning/examples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          why: why.trim(),
          transcript: d.transcript,
          signals: d.correctedSignals,
          sourceFeedbackId: d.id,
          sourceCallId: d.callId,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Promotion failed");
      return json.data;
    },
    onSuccess: () => {
      setError(null);
      setPromoting(null);
      setWhy("");
      qc.invalidateQueries({ queryKey: ["intent-examples"] });
      qc.invalidateQueries({ queryKey: ["intent-disagreements"] });
      qc.invalidateQueries({ queryKey: ["intent-accuracy"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Promotion failed"),
  });

  const toggle = useMutation({
    mutationFn: async (ex: Example) => {
      const res = await fetch(`/api/admin/intent-learning/examples/${ex.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !ex.active }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Update failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["intent-examples"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "Update failed"),
  });

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-xs text-red-600 flex items-start gap-1.5 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
          {error}
        </p>
      )}

      {/* ── 1. Scoreboard ── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5" />
          Report card
          {accuracy && (
            <span className="font-normal normal-case tracking-normal text-gray-400">
              · last {accuracy.windowDays} days
            </span>
          )}
        </h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <Stat
            label="Agreement"
            value={
              accuracy?.agreementRate == null ? "—" : `${accuracy.agreementRate}%`
            }
            hint="How often a reviewer left the AI's band alone"
          />
          <Stat
            label="Reviewed"
            value={accuracy ? String(accuracy.total) : "—"}
            hint="Corrections with a comparable AI band"
          />
          <Stat
            label="Overruled"
            value={accuracy ? String(accuracy.disagreed) : "—"}
            hint="Where a human changed the band"
          />
          <Stat
            label="Teaching the model"
            value={accuracy ? String(accuracy.activeExampleCount) : "—"}
            hint="Active examples in the extraction prompt"
          />
        </div>

        {/* The honest caveat. Without it a rising number reads as "the model is
            getting more correct", which is not what this measures. */}
        <p className="mt-4 text-[11px] leading-relaxed text-gray-500 max-w-3xl">
          This measures <b>agreement with reviewers</b>, not correctness — there
          is no ground truth beyond what people record here. A rising number
          means the model and the team are converging, which is progress only as
          far as the reviewers are right.
          {accuracy != null && accuracy.total < 20 && (
            <>
              {" "}
              With only {accuracy.total} reviewed call
              {accuracy.total === 1 ? "" : "s"}, treat this as noise: aim for
              20–30 before reading anything into it.
            </>
          )}
        </p>

        {accuracy && accuracy.confusion.length > 0 && (
          <div className="mt-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              Where it goes wrong
            </h3>
            <ul className="mt-2 flex flex-wrap gap-2">
              {accuracy.confusion.map((c) => (
                <li
                  key={`${c.aiBand}-${c.humanStatus}`}
                  className="rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] text-gray-700"
                >
                  AI said <b>{c.aiBand}</b> → really{" "}
                  <b className="capitalize">{c.humanStatus}</b>
                  <span className="ml-1.5 text-gray-400">×{c.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ── 2. Disagreements — the promotion queue ── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
          <GraduationCap className="w-3.5 h-3.5" />
          Calls the AI read wrong
        </h2>
        <p className="mt-1 text-[11px] text-gray-500 max-w-3xl">
          Promoting one adds it to the extraction prompt as a worked example. It
          applies to every call scored from then on, and you can switch it off
          again at any time.
        </p>

        {loadingDis ? (
          <p className="mt-4 text-xs text-gray-400 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </p>
        ) : !disagreements || disagreements.length === 0 ? (
          <p className="mt-4 text-xs italic text-gray-400">
            Nothing here yet. Reviewers correct bands from a lead&apos;s detail
            screen or the campaign drawer; corrections with a stored transcript
            show up here.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {disagreements.map((d) => (
              <li key={d.id} className="rounded-xl border border-gray-100 p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-800">
                      {d.leadName || d.leadId || d.callId}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-500">
                      AI said <b>{d.aiBand}</b>
                      {d.aiScore != null && <> ({d.aiScore}/100)</>} → reviewer said{" "}
                      <b className="capitalize">{d.humanStatus}</b>
                      {d.reviewerName && <> · {d.reviewerName}</>}
                      {d.reviewerRole && (
                        <span className="text-gray-400"> ({d.reviewerRole})</span>
                      )}
                    </p>
                    {d.note && (
                      <p className="mt-1 text-[11px] italic text-gray-600">
                        “{d.note}”
                      </p>
                    )}
                  </div>

                  {d.alreadyPromoted ? (
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-emerald-50 border border-emerald-200 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                      <Check className="w-3 h-3" />
                      Teaching
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setPromoting((cur) => (cur === d.id ? null : d.id));
                        setWhy("");
                      }}
                      className="shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 text-[11px] font-semibold text-gray-700 hover:border-gray-400"
                    >
                      {promoting === d.id ? "Cancel" : "Teach the AI this"}
                    </button>
                  )}
                </div>

                {d.transcript && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-600">
                    {d.transcript}
                  </pre>
                )}

                {promoting === d.id && (
                  <div className="mt-3 space-y-2 rounded-xl border border-amber-100 bg-amber-50/40 p-3">
                    <label className="block text-[11px] font-semibold text-gray-700">
                      What should the model learn from this call?
                    </label>
                    {/* This text goes INTO the prompt as the example's heading.
                        Saying so is the difference between a useful lesson and
                        a note to self that confuses the model. */}
                    <p className="text-[10px] text-gray-500">
                      The model reads this sentence. Write the rule, not the
                      verdict — e.g. “A brand name alone is not a battery spec;
                      mark battery_spec_shared no unless a voltage or Ah is
                      stated.”
                    </p>
                    <textarea
                      value={why}
                      onChange={(e) => setWhy(e.target.value)}
                      rows={2}
                      className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                    />
                    <button
                      type="button"
                      disabled={promote.isPending || why.trim().length < 10}
                      onClick={() => promote.mutate(d)}
                      className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {promote.isPending && (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      )}
                      Add to the prompt
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 3. Active examples ── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
          <BookOpen className="w-3.5 h-3.5" />
          What the prompt currently teaches
        </h2>
        <p className="mt-1 text-[11px] text-gray-500 max-w-3xl">
          These are read on every call, in this order — later examples carry more
          weight. Built-in examples are not listed: they ship with the code and
          always apply, as the floor beneath anything promoted here.
        </p>

        {!examples || examples.length === 0 ? (
          <p className="mt-4 text-xs italic text-gray-400">
            Nothing promoted yet — the model is running on its built-in examples
            alone.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {examples.map((ex) => (
              <li
                key={ex.id}
                className={`rounded-xl border p-3 ${
                  ex.active ? "border-gray-100" : "border-gray-100 bg-gray-50/60 opacity-60"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-gray-800">{ex.why}</p>
                    <p className="mt-0.5 text-[10px] text-gray-400">
                      #{ex.sortOrder}
                      {ex.createdByName && <> · added by {ex.createdByName}</>}
                      {!ex.active && <> · inactive</>}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(ex)}
                    title={
                      ex.active
                        ? "Stop using this example — takes effect on the next call"
                        : "Put this example back into the prompt"
                    }
                    className="shrink-0 px-2.5 py-1 rounded-lg border border-gray-200 text-[11px] font-semibold text-gray-600 hover:border-gray-400 inline-flex items-center gap-1"
                  >
                    <Power className="w-3 h-3" />
                    {ex.active ? "Disable" : "Enable"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-gray-100 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">
        {value}
      </p>
      <p className="mt-1 text-[10px] leading-snug text-gray-500">{hint}</p>
    </div>
  );
}
