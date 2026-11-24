"use client";

// 24 Nov tree — the two lead fields, picked the same way on the edit dialog
// and the visit form:
//   Type of business  ONE   Battery Sale | Buyback | Scrap | Other
//   Segment           MANY  3W batteries | 2W batteries | Solar | Inverter | BESS | ESS
//                           (required when the type is Battery Sale)

import { BUSINESS_TYPE_OPTIONS, type BusinessType } from "@/lib/leads/businessType";
import { LEAD_SEGMENTS } from "@/lib/leads/segments";

const chip = (on: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs font-medium ${
        on ? "border-emerald-600 bg-emerald-600 text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
    }`;

/** "" when fine, else what is missing. Exported for the forms' own checks. */
export function typeSegmentProblem(type: BusinessType | "", segments: readonly string[]): string {
    if (!type) return "Pick the type of business.";
    if (type === "battery_sale" && segments.length === 0) return "Pick at least one segment for a battery sale.";
    return "";
}

export function BusinessTypeSegmentPicker({
    type,
    segments,
    onType,
    onSegments,
    typeError,
    segmentError,
}: {
    type: BusinessType | "";
    segments: string[];
    onType: (t: BusinessType) => void;
    onSegments: (s: string[]) => void;
    typeError?: string;
    segmentError?: string;
}) {
    const segmentRequired = type === "battery_sale";
    const toggle = (s: string) => onSegments(segments.includes(s) ? segments.filter((x) => x !== s) : [...segments, s]);
    // Older stored values (Auto-Parts, Battery) stay visible and removable.
    const legacy = segments.filter((s) => !(LEAD_SEGMENTS as readonly string[]).includes(s));
    return (
        <div className="space-y-3">
            <div>
                <div className="text-xs font-medium text-gray-700">
                    Type of business <span className="text-rose-600">*</span>{" "}
                    <span className="font-normal text-gray-500">— pick one: what deal is this?</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Type of business">
                    {BUSINESS_TYPE_OPTIONS.map((o) => (
                        <button
                            key={o.value}
                            type="button"
                            role="radio"
                            aria-checked={type === o.value}
                            onClick={() => onType(o.value)}
                            className={chip(type === o.value)}
                        >
                            {o.label}
                        </button>
                    ))}
                </div>
                {typeError && <p className="mt-1 text-[11px] text-rose-600">{typeError}</p>}
            </div>
            <div>
                <div className="text-xs font-medium text-gray-700">
                    Segment {segmentRequired && <span className="text-rose-600">*</span>}{" "}
                    <span className="font-normal text-gray-500">— pick one or more: what does the dealer sell?</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Segment">
                    {[...LEAD_SEGMENTS, ...legacy].map((s) => (
                        <button
                            key={s}
                            type="button"
                            role="checkbox"
                            aria-checked={segments.includes(s)}
                            onClick={() => toggle(s)}
                            className={chip(segments.includes(s))}
                        >
                            {s}
                        </button>
                    ))}
                </div>
                {segmentError && <p className="mt-1 text-[11px] text-rose-600">{segmentError}</p>}
            </div>
        </div>
    );
}
