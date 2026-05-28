"use client";

import { useState } from "react";
import type { RecommendedActionKey } from "./types";

interface Option {
  key: RecommendedActionKey;
  label: string;
  sub: string;
  icon: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface Props {
  immobilisationEligible: boolean;
  onContinue: (key: RecommendedActionKey) => void;
}

const OPTIONS_BASE: Option[] = [
  {
    key: "payment_reminder",
    label: "Send payment reminder",
    sub: "Auto-notification · no approval required",
    icon: "✈",
  },
  {
    key: "field_visit",
    label: "Request field visit",
    sub: "Assign agent · single approval",
    icon: "🔧",
  },
  {
    key: "immobilisation",
    label: "Request immobilisation",
    sub: "Dual approval required · Risk Head + Ops",
    icon: "🔒",
  },
  {
    key: "restructuring",
    label: "Review for loan restructuring",
    sub: "Dual approval required · compliance review",
    icon: "❗",
  },
];

export function RecommendedActions({ immobilisationEligible, onContinue }: Props) {
  const [selected, setSelected] = useState<RecommendedActionKey | null>(null);

  const options: Option[] = OPTIONS_BASE.map((o) =>
    o.key === "immobilisation" && !immobilisationEligible
      ? {
          ...o,
          disabled: true,
          disabledReason:
            "Not eligible — account below the high-risk band (CDS < 70 and DPD < 30).",
        }
      : o,
  );

  return (
    <section aria-labelledby="recommended-actions-title">
      <h3
        id="recommended-actions-title"
        className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]"
      >
        Recommended actions
      </h3>
      <ul className="space-y-2">
        {options.map((o) => {
          const active = selected === o.key;
          return (
            <li key={o.key}>
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                  active
                    ? "border-sky-400 bg-sky-50"
                    : "border-[color:var(--color-border)] bg-[color:var(--color-surface)] hover:border-sky-200"
                } ${o.disabled ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name="recommended-action"
                  value={o.key}
                  checked={active}
                  onChange={() => setSelected(o.key)}
                  disabled={o.disabled}
                  className="mt-1"
                />
                <span className="text-base" aria-hidden>
                  {o.icon}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold">{o.label}</p>
                  <p className="text-xs text-[color:var(--color-ink-muted)]">
                    {o.sub}
                  </p>
                  {o.disabled && o.disabledReason ? (
                    <p className="mt-1 text-xs italic text-[color:var(--color-ink-muted)]">
                      {o.disabledReason}
                    </p>
                  ) : null}
                </div>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onContinue(selected)}
          className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
        >
          Continue to action →
        </button>
      </div>
    </section>
  );
}

export default RecommendedActions;
