"use client";

/**
 * LeadStageStepper — guided origination progress for the NBFC Acquire workspace
 * (BRD Addendum V0.2 §6 / §9 / §10 / §11).
 *
 * Interactive accordion: clicking a stage node opens THAT step's panel inline
 * under the rail and collapses the others. A `done` step opens as a read-only,
 * locked summary (its action panel self-disables once the step succeeds), badged
 * "Completed" so a successful step can no longer be changed.
 *
 * Five stages: Verification (Stage-1 parallel FI + VKYC) → Offer → Winner
 * decision → E-NACH + Agreement (Stage-2, winner-only) → Disbursal. The server
 * page derives each stage's state + content; this component owns only the
 * open/collapse UI state.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, Lock, X } from "lucide-react";

/** Event a step's content can dispatch to make the stepper open another step. */
export const OPEN_STEP_EVENT = "nbfc:acquire-open-step";

export type NodeState = "done" | "active" | "locked" | "failed";

export interface StepperStage {
  key: string;
  label: string;
  /** Short status line under the label. */
  sub?: string;
  state: NodeState;
  /** Accordion body shown when this node is open. */
  content?: ReactNode;
}

export type BannerTone = "info" | "success" | "danger" | "muted";

export interface NextAction {
  tone: BannerTone;
  text: string;
}

const NODE_TONE: Record<NodeState, string> = {
  done: "bg-emerald-500 text-white border-emerald-500",
  active:
    "bg-[color:var(--color-brand-navy)] text-white border-[color:var(--color-brand-navy)] ring-4 ring-[color:var(--color-brand-navy)]/15",
  failed: "bg-rose-500 text-white border-rose-500",
  locked: "bg-white text-slate-300 border-slate-200",
};

const LABEL_TONE: Record<NodeState, string> = {
  done: "text-slate-700",
  active: "text-[color:var(--color-brand-navy)] font-semibold",
  failed: "text-rose-600 font-semibold",
  locked: "text-slate-400",
};

const BANNER_TONE: Record<BannerTone, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  muted: "border-slate-200 bg-slate-50 text-slate-600",
};

const STATE_BADGE: Record<NodeState, { label: string; cls: string }> = {
  done: {
    label: "Completed",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  active: {
    label: "In progress",
    cls: "bg-[color:var(--color-brand-navy)]/5 text-[color:var(--color-brand-navy)] border-[color:var(--color-brand-navy)]/20",
  },
  failed: {
    label: "Action needed",
    cls: "bg-rose-50 text-rose-700 border-rose-200",
  },
  locked: { label: "Locked", cls: "bg-slate-50 text-slate-500 border-slate-200" },
};

function NodeIcon({ state, index }: { state: NodeState; index: number }) {
  if (state === "done") return <Check className="h-4 w-4" />;
  if (state === "failed") return <X className="h-4 w-4" />;
  if (state === "locked") return <Lock className="h-3.5 w-3.5" />;
  return <span className="text-xs font-bold">{index + 1}</span>;
}

export default function LeadStageStepper({
  stages,
  nextAction,
}: {
  stages: StepperStage[];
  nextAction: NextAction;
}) {
  // Default the accordion to the first step needing attention (active/failed),
  // else the most recently completed step, else the first node.
  const initialKey = (() => {
    const attn = stages.find(
      (s) => s.state === "active" || s.state === "failed",
    );
    if (attn) return attn.key;
    const lastDone = [...stages].reverse().find((s) => s.state === "done");
    return lastDone?.key ?? stages[0]?.key ?? null;
  })();
  const [openKey, setOpenKey] = useState<string | null>(initialKey);
  const openStage = stages.find((s) => s.key === openKey) ?? null;

  // Let a step's content (e.g. the dossier "Next: Offer" button) drive which
  // step is open, then scroll its panel into view.
  useEffect(() => {
    function onOpenStep(e: Event) {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (!key || !stages.some((s) => s.key === key)) return;
      setOpenKey(key);
      requestAnimationFrame(() => {
        document
          .getElementById(`stage-panel-${key}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    window.addEventListener(OPEN_STEP_EVENT, onOpenStep as EventListener);
    return () =>
      window.removeEventListener(OPEN_STEP_EVENT, onOpenStep as EventListener);
  }, [stages]);

  return (
    <section className="border border-slate-200 rounded-xl bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-5">
        Origination progress
      </h2>

      <ol className="flex items-start">
        {stages.map((s, i) => {
          const connectorDone = stages[i - 1]?.state === "done";
          const isOpen = s.key === openKey;
          return (
            <li
              key={s.key}
              className="flex-1 flex flex-col items-center text-center relative"
            >
              {/* Connector to the previous node. */}
              {i > 0 && (
                <span
                  className={`absolute top-4 right-1/2 left-[-50%] h-0.5 ${
                    connectorDone ? "bg-emerald-400" : "bg-slate-200"
                  }`}
                  aria-hidden
                />
              )}
              <button
                type="button"
                onClick={() => setOpenKey(isOpen ? null : s.key)}
                aria-expanded={isOpen}
                aria-controls={`stage-panel-${s.key}`}
                className="group flex flex-col items-center focus:outline-none"
              >
                <span
                  className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border transition ${
                    NODE_TONE[s.state]
                  } ${
                    isOpen
                      ? "ring-2 ring-offset-2 ring-[color:var(--color-brand-sky)]"
                      : "group-hover:brightness-95"
                  }`}
                >
                  <NodeIcon state={s.state} index={i} />
                </span>
                <span
                  className={`mt-2 text-[11px] leading-tight ${LABEL_TONE[s.state]}`}
                >
                  {s.label}
                </span>
                {s.sub && (
                  <span className="mt-0.5 text-[10px] text-slate-400 leading-tight">
                    {s.sub}
                  </span>
                )}
                <ChevronDown
                  className={`mt-1 h-3 w-3 text-slate-300 transition ${
                    isOpen ? "rotate-180 text-[color:var(--color-brand-sky)]" : ""
                  }`}
                  aria-hidden
                />
              </button>
            </li>
          );
        })}
      </ol>

      {openStage && (
        <div
          id={`stage-panel-${openStage.key}`}
          className="mt-5 rounded-lg border border-slate-200 bg-slate-50/60 p-4"
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              {openStage.state === "done" && (
                <Lock className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
              )}
              <h3 className="text-sm font-semibold text-slate-800">
                {openStage.label}
              </h3>
            </div>
            <span
              className={`px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${
                STATE_BADGE[openStage.state].cls
              }`}
            >
              {STATE_BADGE[openStage.state].label}
            </span>
          </div>

          {openStage.state === "done" && (
            <p className="text-[11px] text-slate-500 mb-3">
              This step is complete and locked — the values below are read-only.
            </p>
          )}

          <div>
            {openStage.content ?? (
              <p className="text-sm text-slate-500">No details for this step.</p>
            )}
          </div>
        </div>
      )}

      <div
        className={`mt-5 rounded-lg border px-3 py-2.5 text-xs font-medium leading-relaxed ${BANNER_TONE[nextAction.tone]}`}
      >
        <span className="font-bold uppercase tracking-wider text-[10px] mr-1.5">
          Next
        </span>
        {nextAction.text}
      </div>
    </section>
  );
}
