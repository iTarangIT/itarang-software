"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CardForUi } from "./SeverityTabs";
import {
  SEVERITY_COLOR_TOKENS,
  SEVERITY_LABELS,
  VERDICT_SOURCE_LABELS,
  isComputed,
} from "@/lib/risk/severity";

export default function RiskCardDrawer({
  card,
  onClose,
}: {
  card: CardForUi;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tone = SEVERITY_COLOR_TOKENS[card.severity];
  const computed = isComputed(card.verdict_source);
  const sample = card.evidence?.sample_rows ?? [];
  const notes = card.evidence?.notes ?? [];

  return (
    <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose}>
      <div
        className="absolute right-0 top-0 bottom-0 w-full md:w-[640px] bg-white dark:bg-slate-950 shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 p-5 flex items-start gap-4">
          <div className="flex-1">
            <div
              className={`inline-block text-xs font-semibold uppercase px-2 py-0.5 rounded ${tone.bg} ${tone.fg}`}
            >
              {SEVERITY_LABELS[card.severity]}
            </div>
            <h2 className="mt-2 text-lg font-semibold">{card.title}</h2>
            <p className="text-sm text-slate-500 mt-1">{card.finding_summary}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-900 px-2 py-1"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-6">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Hypothesis
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
              {card.description}
            </p>
          </section>

          {computed ? (
            <section className="grid grid-cols-3 gap-3">
              <Stat label="Affected" value={card.affected_count.toLocaleString("en-IN")} />
              <Stat label="Total" value={card.total_count.toLocaleString("en-IN")} />
              <Stat
                label="Share"
                value={
                  card.total_count > 0
                    ? ((100 * card.affected_count) / card.total_count).toFixed(1) + "%"
                    : "—"
                }
              />
            </section>
          ) : (
            <section className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-4 py-3 text-sm text-slate-600 dark:text-slate-400">
              No counts are shown because no verdict was computed for this hypothesis. This is a gap
              in coverage, not a finding about the portfolio.
            </section>
          )}

          {card.source !== "human" && !card.promoted && (
            <section className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-4 py-3">
              <p className="text-sm text-slate-700 dark:text-slate-300">
                <strong className="font-semibold">Unvetted hypothesis.</strong> The agent wrote both
                the question and the code that answers it, and no human has reviewed either. Its
                severity is capped at <strong>Warning</strong> — it can raise a concern, but it
                cannot declare a High Alert until someone promotes it.
                {card.evidence?.severity_capped ? (
                  <>
                    {" "}
                    <span className="text-amber-700 dark:text-amber-400">
                      This run computed HIGH and was capped to Warning.
                    </span>
                  </>
                ) : null}
              </p>
              <PromoteControls hypothesisId={card.hypothesis_id} />
            </section>
          )}

          {card.verdict_source === "legacy_llm" && (
            <section className="rounded-md border border-violet-200 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/30 px-4 py-3 text-sm text-violet-900 dark:text-violet-300">
              <strong className="font-semibold">Unverified.</strong> This card was written before
              verdict provenance was tracked (E-185). At the time, the engine fell back to asking a
              language model to state the severity and counts whenever the Python sandbox was
              unavailable — so these numbers may never have been computed from data. Re-run the
              analysis to replace it.
            </section>
          )}

          {sample.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Sample evidence ({sample.length})
              </h3>
              <div className="mt-2 overflow-x-auto rounded border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900 text-xs text-slate-500 uppercase">
                    <tr>
                      {Object.keys(sample[0] ?? {}).map((k) => (
                        <th key={k} className="px-3 py-2 text-left font-medium">
                          {k}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sample.map((row, i) => (
                      <tr
                        key={i}
                        className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/50"
                      >
                        {Object.values(row).map((v, j) => (
                          <td key={j} className="px-3 py-1.5 tabular-nums">
                            {fmtCell(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {notes.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Methodology notes
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-400 list-disc pl-5">
                {notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          )}

          {card.critique ? (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Caveats
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                {card.critique}
              </p>
            </section>
          ) : null}

          <section className="text-xs text-slate-500">
            {card.run_at ? (
              <>Last run {new Date(card.run_at).toLocaleString()}</>
            ) : (
              <>Live evaluation — not yet persisted to risk_card_runs.</>
            )}
            {" · "}
            Verdict: {VERDICT_SOURCE_LABELS[card.verdict_source]}
            {" · "}
            Hypothesis author: {card.source === "human" ? "hand-coded" : card.source}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Promote (trust it enough to let it raise a High Alert) or retire (stop running
 * it). Both act on the HYPOTHESIS, not on today's card — the judgement is about
 * the question and the code, and it persists across runs.
 */
function PromoteControls({ hypothesisId }: { hypothesisId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"promote" | "retire" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const act = async (kind: "promote" | "retire") => {
    setBusy(kind);
    setMsg(null);
    try {
      const r = await fetch(`/api/nbfc/risk/hypotheses/${hypothesisId}/promote`, {
        method: kind === "promote" ? "POST" : "DELETE",
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || data.ok === false) {
        setMsg(`Error: ${data.error ?? r.statusText}`);
        return;
      }
      setMsg(
        kind === "promote"
          ? "Promoted — it can raise a High Alert from the next run."
          : "Retired — it will no longer be run.",
      );
      router.refresh();
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={() => act("promote")}
        disabled={busy !== null}
        className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {busy === "promote" ? "Promoting…" : "Promote"}
      </button>
      <button
        type="button"
        onClick={() => act("retire")}
        disabled={busy !== null}
        className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60"
      >
        {busy === "retire" ? "Retiring…" : "Retire"}
      </button>
      {msg && (
        <span className={`text-xs ${msg.startsWith("Error") ? "text-red-600" : "text-emerald-600"}`}>
          {msg}
        </span>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-base font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function fmtCell(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
