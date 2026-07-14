"use client";

/**
 * THE battery-line label component (BRD M02, invariant 7).
 *
 * Every screen — intake, review, negotiation, margin, the offer panel — renders a
 * battery line through this. Nobody builds the string themselves.
 *
 * The prototype's `[object Object]` bug came from per-screen string templates;
 * this takes the line OBJECT and renders structured parts, so there is nothing to
 * mis-interpolate. The condition is a coloured chip, not a word glued onto a
 * string, which is also why the design's chip colours only exist in one file.
 */

import { formatBatteryLine, type FormattableLine } from "@/lib/buyback/format";

export function ConditionChip({ condition }: { condition: "WORKING" | "DEAD" }) {
  const working = condition === "WORKING";
  return (
    <span
      className={`inline-flex rounded-xl px-2 py-[1px] text-[11px] font-bold ${
        working ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
      }`}
    >
      {working ? "Working" : "Dead"}
    </span>
  );
}

interface Props {
  line: FormattableLine;
  /** Hide the ×N suffix where the count is already a column of its own. */
  showCount?: boolean;
  className?: string;
}

export default function BatteryLineLabel({ line, showCount = true, className = "" }: Props) {
  const f = formatBatteryLine(line);

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="font-semibold text-slate-900">{f.specLabel}</span>
      <ConditionChip condition={f.conditionKey} />
      {showCount && (
        <span className="tabular-nums text-slate-500">{f.countLabel}</span>
      )}
    </span>
  );
}
