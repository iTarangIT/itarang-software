"use client";

// "This band is wrong" — the one correction form, used by both hosts.
//
// Lifted out of CampaignLeadTranscriptDrawer.tsx (where it was ~280 lines of a
// 1543-line file) so the campaign drawer and the lead-detail panel share ONE
// implementation. Two copies of this would drift: correcting a band is now an
// override that moves the lead through the pipeline, and a guard added to one
// copy but not the other would mean a lead behaves differently depending on
// which screen corrected it.
//
// It posts to the LEAD-scoped route. The campaign-scoped path still exists as a
// shim that forwards there, but there is no reason for new code to go through
// it — a correction is a fact about the call and the lead, not about whichever
// campaign happened to dial it.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, Pencil } from "lucide-react";

export type ClientSignals = { [k: string]: unknown };

const DISQUALIFIER_OPTIONS = [
  "none",
  "dont_call",
  "hostile",
  "not_interested",
  "call_dropped",
];

// The yes/no facts a reviewer can flip in deep mode. The five marked `info`
// drive info_signals_count. Mirrors src/lib/ai/scoring/signals.ts — kept in
// sync by hand, as it was before this move.
export const CORRECTABLE_FACTS: Array<{
  key: string;
  label: string;
  info: boolean;
}> = [
  { key: "relevant_dealer", label: "Relevant dealer", info: false },
  { key: "battery_spec_shared", label: "Battery spec shared", info: true },
  { key: "volume_shared", label: "Volume shared", info: true },
  {
    key: "existing_financier_shared",
    label: "Existing financier shared",
    info: true,
  },
  {
    key: "financing_need_expressed",
    label: "Financing need expressed",
    info: true,
  },
  {
    key: "financing_value_acknowledged",
    label: "Financing value acknowledged",
    info: true,
  },
  { key: "pitch_heard", label: "Pitch heard", info: false },
  { key: "callback_agreed", label: "Callback agreed", info: false },
];

const LEAD_STATUS_OPTIONS = [
  "qualified",
  "warm",
  "cold",
  "disqualified",
] as const;

export interface CorrectionRow {
  id: string;
  correctedStatus: string;
  correctedScore: number | null;
  aiBand?: string | null;
  agreed?: boolean | null;
  appliedToLead?: boolean | null;
  note?: string | null;
  reviewerName?: string | null;
  createdAt?: string | null;
}

export function CorrectIntentForm({
  leadId,
  callId,
  intentScore,
  aiBand,
  signals,
  recordingId,
  onSaved,
}: {
  leadId: string;
  /** null when the AI never called this lead and the reviewer is judging their own attached audio. */
  callId: string | null;
  intentScore: number | null;
  aiBand?: string | null;
  signals: ClientSignals | null;
  /** Attached audio submitted as the explanation, instead of a typed note. */
  recordingId?: string | null;
  /** Extra cache keys to refresh — lets each host invalidate its own views. */
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [openPanel, setOpenPanel] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [scoreText, setScoreText] = useState<string>("");
  const [note, setNote] = useState("");
  const [deep, setDeep] = useState(false);
  const [facts, setFacts] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const { key } of CORRECTABLE_FACTS) {
      seed[key] = (signals?.[key] as string | undefined) ?? "no";
    }
    return seed;
  });
  const [disq, setDisq] = useState<string>(
    (signals?.disqualifier as string | undefined) ?? "none",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feedbackKey = ["intent-feedback", leadId, callId ?? "no-call"];
  const { data: existing } = useQuery<{ feedback: CorrectionRow[] }>({
    queryKey: feedbackKey,
    queryFn: async () => {
      const qs = callId ? `?callId=${encodeURIComponent(callId)}` : "";
      const res = await fetch(
        `/api/dealer-leads/${encodeURIComponent(leadId)}/intent-feedback${qs}`,
      );
      const json = await res.json();
      return json?.success ? json.data : { feedback: [] };
    },
  });

  const lastCorrection = existing?.feedback?.[0] ?? null;

  async function submit() {
    if (!status) {
      setError("Pick the correct status first.");
      return;
    }
    setSubmitting(true);
    setError(null);

    // Deep mode: carry the original signals through, overriding edited facts.
    let correctedSignals: ClientSignals | null = null;
    if (deep) {
      const base: ClientSignals = signals ? { ...signals } : {};
      for (const { key } of CORRECTABLE_FACTS) {
        base[key] = facts[key];
      }
      base.disqualifier = disq;
      correctedSignals = base;
    }

    const parsedScore = scoreText.trim() === "" ? null : Number(scoreText);

    try {
      const res = await fetch(
        `/api/dealer-leads/${encodeURIComponent(leadId)}/intent-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callId,
            correctedStatus: status,
            correctedScore:
              parsedScore != null && Number.isFinite(parsedScore)
                ? parsedScore
                : null,
            correctedSignals,
            note: note.trim() || null,
            recordingId: recordingId ?? null,
          }),
        },
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Save failed");

      await qc.invalidateQueries({ queryKey: feedbackKey });
      // The override moves the lead's band and score, so everything showing
      // either is now stale. Broad on purpose: a corrected lead that still
      // reads "Cold" two screens away is exactly the confusion this feature
      // exists to remove.
      qc.invalidateQueries({ queryKey: ["lead-ai-summary", leadId] });
      qc.invalidateQueries({ queryKey: ["dealer-leads"] });
      qc.invalidateQueries({ queryKey: ["inside-sales-lead", leadId] });
      qc.invalidateQueries({ queryKey: ["asm-lead", leadId] });
      onSaved?.();

      setOpenPanel(false);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Two states, deliberately weighted very differently ──
  //
  // CLOSED, this is an offer, not an alarm. It used to render as a full amber
  // alert box with a shouting uppercase heading, which made "BAND LOOKS WRONG?"
  // the loudest thing in the sidebar — louder than the band it was asking you to
  // check. An alert style also asserts something IS wrong, when the AI is right
  // most of the time. So closed it is a plain secondary button, in the same
  // visual register as the other actions on the page.
  //
  // OPEN, the amber returns: you are now editing something that will move the
  // lead through the pipeline, and the form should feel distinct from the
  // read-only panels around it. Colour earns its place once there is a live,
  // consequential edit in progress.
  if (!openPanel) {
    return (
      <div className="space-y-2">
        {lastCorrection && (
          <p className="text-[11px] text-emerald-700 flex items-start gap-1.5">
            <CheckCircle2 className="w-3 h-3 mt-px shrink-0" />
            <span>
              Corrected to{" "}
              <b className="capitalize">{lastCorrection.correctedStatus}</b>
              {lastCorrection.correctedScore != null && (
                <> ({lastCorrection.correctedScore}/100)</>
              )}
              {lastCorrection.reviewerName && (
                <> by {lastCorrection.reviewerName}</>
              )}
            </span>
          </p>
        )}
        <button
          type="button"
          onClick={() => setOpenPanel(true)}
          className="w-full h-9 rounded-lg border border-gray-200 text-xs font-semibold text-gray-700 hover:border-gray-400 hover:bg-gray-50 inline-flex items-center justify-center gap-1.5"
        >
          <Pencil className="w-3.5 h-3.5 shrink-0" />
          {lastCorrection ? "Correct the band again" : "Correct the band"}
        </button>
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          Correct the band
        </h3>
      </div>

      {lastCorrection && (
        <p className="mt-2 text-[11px] text-amber-700 flex items-start gap-1.5">
          <CheckCircle2 className="w-3 h-3 mt-px shrink-0" />
          <span>
            Last corrected to{" "}
            <b className="capitalize">{lastCorrection.correctedStatus}</b>
            {lastCorrection.correctedScore != null && (
              <> ({lastCorrection.correctedScore}/100)</>
            )}
            {lastCorrection.reviewerName && (
              <> by {lastCorrection.reviewerName}</>
            )}
          </span>
        </p>
      )}

      <div className="mt-3 space-y-3">
        {/* Says what the save actually DOES. The old copy said "so it can
              learn", which was true and also the whole problem: it ONLY
              learned, and reviewers reasonably assumed the lead had moved. */}
        {/* Says what the save actually DOES, and branches on whether there IS an
            AI band to argue with. A null band is common — every dropped_empty
            call produces one — and the single-sentence version rendered as
            "The AI called this — (75/100)", which reads as a broken template and
            pairs an em dash with a score that came from an earlier call. */}
        <p className="text-[11px] text-gray-600">
          {aiBand ? (
            <>
              The AI called this <b>{aiBand}</b>
              {intentScore != null && <> ({intentScore}/100)</>}.{" "}
            </>
          ) : (
            <>The AI never reached a band on this call. </>
          )}
          Your correction becomes this lead&apos;s live band straight away, and
          teaches the scoring model.
        </p>

        {/* Quick mode — the true status label */}
        <div>
          <label className="block text-[11px] font-semibold text-gray-600 mb-1">
            Correct status
          </label>
          <div className="flex flex-wrap gap-1.5">
            {LEAD_STATUS_OPTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold capitalize border ${
                  status === s
                    ? "bg-amber-500 text-white border-amber-500"
                    : "bg-white text-gray-700 border-gray-200 hover:border-amber-300"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[11px] font-semibold text-gray-600">
            Correct score (optional)
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={scoreText}
            onChange={(e) => setScoreText(e.target.value)}
            placeholder="0–100"
            className="w-20 h-8 rounded-lg border border-gray-200 px-2 text-xs"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold text-gray-600 mb-1">
            Note (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="e.g. only two garbled lines, dealer showed no real interest"
            className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
          />
        </div>

        {/* Deep mode — per-fact yes/no correction */}
        <button
          type="button"
          onClick={() => setDeep((d) => !d)}
          className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2"
        >
          {deep ? "Hide signal details" : "Refine signals (advanced)"}
        </button>
        {deep && (
          <div className="space-y-2 rounded-xl border border-amber-100 bg-white p-3">
            {CORRECTABLE_FACTS.map(({ key, label, info }) => {
              const val = facts[key] ?? "no";
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-[11px] text-gray-600 flex items-center gap-1">
                    {label}
                    {info && (
                      <span className="text-[8px] uppercase tracking-wide text-gray-400 bg-gray-100 rounded px-1 py-px">
                        info
                      </span>
                    )}
                  </span>
                  <div className="flex gap-1">
                    {["yes", "no"].map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() =>
                          setFacts((prev) => ({ ...prev, [key]: opt }))
                        }
                        className={`px-2 py-0.5 rounded text-[11px] font-semibold capitalize border ${
                          val === opt
                            ? opt === "yes"
                              ? "bg-emerald-500 text-white border-emerald-500"
                              : "bg-gray-400 text-white border-gray-400"
                            : "bg-white text-gray-600 border-gray-200 hover:border-amber-300"
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <label className="flex items-center justify-between gap-2 pt-1 border-t border-gray-100">
              <span className="text-[11px] text-gray-600">Disqualifier</span>
              <select
                value={disq}
                onChange={(e) => setDisq(e.target.value)}
                className="h-8 rounded-lg border border-gray-200 px-1 text-xs"
              >
                {DISQUALIFIER_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {error && <p className="text-[11px] text-red-600">{error}</p>}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
            Save correction
          </button>
          <button
            type="button"
            onClick={() => setOpenPanel(false)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}
