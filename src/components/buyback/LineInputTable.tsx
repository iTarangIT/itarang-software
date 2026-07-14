"use client";

/**
 * The per-SKU price editor (BRD P5).
 *
 * Used by the admin's Negotiate modal, the admin's Final Offer modal AND the
 * dealer's counter composer — one component, so no screen can quietly offer a
 * lump-sum box. (The prototype's dealer composer was a single "counter ₹/unit"
 * input; that is the thing this exists to prevent.)
 *
 * State is keyed by LINE ID, never by the formatted label. Two lines with the
 * same SKU and condition produce identical labels, and the prototype's
 * label-keyed map silently merged them.
 */

import BatteryLineLabel from "./BatteryLineLabel";
import { inr } from "@/lib/buyback/format";

export interface EditableLine {
  id: string;
  quantity: number;
  condition: "WORKING" | "DEAD";
  voltage: number | string;
  ah: number | string;
  /** Shown under the label as context, e.g. the dealer's current ask. */
  reference_price?: number | string | null;
}

interface Props {
  lines: EditableLine[];
  /** line_id → ₹/unit. */
  values: Record<string, string>;
  onChange: (lineId: string, value: string) => void;
  referenceLabel?: string;
  disabled?: boolean;
}

export default function LineInputTable({
  lines,
  values,
  onChange,
  referenceLabel = "dealer",
  disabled = false,
}: Props) {
  const total = lines.reduce((sum, l) => {
    const v = Number(values[l.id]);
    return Number.isFinite(v) ? sum + v * l.quantity : sum;
  }, 0);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      {lines.map((line, i) => (
        <div
          key={line.id}
          className={`grid grid-cols-[1.4fr_0.9fr] items-center gap-3 px-3 py-2.5 ${
            i > 0 ? "border-t border-slate-100" : ""
          }`}
        >
          <div>
            <BatteryLineLabel line={line} showCount={false} />
            <div className="mt-0.5 text-xs text-slate-500">
              ×{line.quantity}
              {line.reference_price != null && (
                <> · {referenceLabel} {inr(line.reference_price)}</>
              )}
            </div>
          </div>

          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">
              ₹
            </span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              disabled={disabled}
              // Keyed by id. Not by the label.
              value={values[line.id] ?? ""}
              onChange={(e) => onChange(line.id, e.target.value)}
              placeholder="0"
              className="w-full rounded-lg border border-slate-200 py-2 pl-6 pr-2 text-sm tabular-nums focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
              aria-label={`Price per unit for ${line.voltage}V ${line.ah}Ah`}
            />
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between border-t border-slate-200 bg-emerald-50 px-3 py-2.5 text-sm font-bold text-emerald-800">
        <span>Order total</span>
        <span className="tabular-nums">{inr(total)}</span>
      </div>
    </div>
  );
}
