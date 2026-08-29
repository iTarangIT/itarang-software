"use client";

/**
 * BatteryEvaluationPanel — persistent right-side evaluation panel for the
 * Recovery & Auction page (BRD §6.1.7).
 *
 * Replaces the old modal-launched PendingEvaluationsList: the operator picks a
 * battery that is awaiting inspection from a dropdown, and the 3-step
 * BatteryEvaluationWizard renders inline. A fresh `key` per battery resets the
 * wizard on switch; on completion the page is refreshed so the evaluated
 * battery leaves the "needs inspection" set.
 *
 * DEEP-LINKABLE. The recovery board's cards link here as
 * `?evaluate=<pipeline id>#battery-evaluation` when a stage move is blocked
 * on a missing evaluation — the wizard is in a different section of the page
 * from the buttons it unlocks, and an operator who only saw the greyed-out
 * buttons had no path to it. `#battery-evaluation` scrolls; `?evaluate=`
 * preselects. The param is only the INITIAL selection: once the operator picks
 * something else in the dropdown their choice wins, and an id that is no
 * longer awaiting inspection falls back to the first candidate.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { BatteryEvaluationWizard } from "@/components/nbfc-portal/BatteryEvaluationWizard";

export type PendingEvaluationRow = {
  id: string;
  battery_serial: string;
  borrower_name: string | null;
  live_soh_pct: number | null;
  age_days: number;
  /** null until the battery master row exists — the wizard offers to make it. */
  battery_id: string | null;
};

export default function BatteryEvaluationPanel({
  candidates,
}: {
  candidates: PendingEvaluationRow[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get("evaluate");
  const [selectedId, setSelectedId] = useState<string>(
    (requested && candidates.some((c) => c.id === requested)
      ? requested
      : candidates[0]?.id) ?? "",
  );
  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  if (candidates.length === 0) {
    return (
      <div id="battery-evaluation" className="card-iTarang p-4 scroll-mt-6">
        <p className="section-label-muted">Battery evaluation</p>
        <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          3-step inspection
        </p>
        <p className="mt-6 text-center text-sm text-[color:var(--color-ink-muted)]">
          No batteries awaiting inspection.
        </p>
      </div>
    );
  }

  return (
    <div id="battery-evaluation" className="card-iTarang p-4 space-y-3 scroll-mt-6">
      <div>
        <p className="section-label-muted">Battery evaluation</p>
        <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          3-step form · Technical → Refurbishment → Pricing
        </p>
        <p className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
          Base auction price auto-computes from SOH on submit.
        </p>
      </div>

      <div>
        <label
          htmlFor="evaluation-battery"
          className="block text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)] mb-1"
        >
          Battery awaiting inspection ({candidates.length})
        </label>
        <select
          id="evaluation-battery"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full border border-[color:var(--color-border)] rounded-lg px-2.5 py-1.5 text-sm bg-[color:var(--color-surface)]"
        >
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.battery_serial}
              {c.borrower_name ? ` — ${c.borrower_name}` : ""}
              {c.live_soh_pct != null ? ` (SOH ${c.live_soh_pct}%)` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="border-t border-[color:var(--color-border)] pt-3">
        {selected ? (
          <BatteryEvaluationWizard
            key={selected.id}
            recoveryPipelineId={selected.id}
            batteryId={selected.battery_id}
            batterySerial={selected.battery_serial}
            onComplete={() => router.refresh()}
          />
        ) : null}
      </div>
    </div>
  );
}
