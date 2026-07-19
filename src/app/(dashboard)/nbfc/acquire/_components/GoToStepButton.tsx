"use client";

// Advances the on-page origination stepper to another step by dispatching the
// `nbfc:acquire-open-step` event the stepper listens for (no navigation). Used
// e.g. by the Offer step to move a winning lead on to the FI & V-KYC step.

import { ArrowRight } from "lucide-react";

export const OPEN_STEP_EVENT = "nbfc:acquire-open-step";

export default function GoToStepButton({
  stepKey,
  label,
}: {
  stepKey: string;
  label: string;
}) {
  function go() {
    window.dispatchEvent(
      new CustomEvent(OPEN_STEP_EVENT, { detail: { key: stepKey } }),
    );
  }

  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={go}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
      >
        {label}
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
