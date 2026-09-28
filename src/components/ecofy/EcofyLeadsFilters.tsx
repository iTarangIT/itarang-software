"use client";

// The "Filters" disclosure of the Ecofy leads list. Same trigger, badge and
// grid as the queues' QueueFilterBar (whose cells are reused), with the
// questions that make sense for an Ecofy case: stage, temperature, segment
// and — for the Sales Head — owner.

import { ChevronDown, RotateCcw, SlidersHorizontal } from "lucide-react";
import { QUEUE_SELECT_CLASS, QueueFilterField } from "@/components/leads/QueueFilterBar";
import { ECOFY_ROLE_LABEL, ECOFY_STAGE_LABELS } from "@/lib/ecofy/access";
import { ECOFY_FILTER_KEYS, ECOFY_SEGMENTS, type EcofyFilterKey } from "@/lib/ecofy/listTypes";
import { useEcofyAssignees } from "./EcofyAssignBar";

export type EcofyFilterValues = Record<EcofyFilterKey, string>;
export const EMPTY_ECOFY_FILTERS: EcofyFilterValues = { stage: "", temperature: "", segment: "", assignee: "" };

export function countEcofyFilters(v: EcofyFilterValues): number {
    return ECOFY_FILTER_KEYS.filter((k) => v[k]).length;
}

export function EcofyLeadsFilters({
    values,
    onChange,
    onReset,
    open,
    onToggle,
    showOwner,
}: {
    values: EcofyFilterValues;
    onChange: (key: EcofyFilterKey, value: string) => void;
    onReset: () => void;
    open: boolean;
    onToggle: () => void;
    showOwner: boolean;
}) {
    const assignees = useEcofyAssignees(showOwner && open);
    const activeCount = countEcofyFilters(values);

    return (
        <>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                    activeCount > 0 ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                }`}
            >
                <SlidersHorizontal className="h-4 w-4" />
                Filters
                {activeCount > 0 && <span className="rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold text-white">{activeCount}</span>}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>

            {open && (
                // `order-last w-full`: the trigger stays inline with the search box
                // while the panel drops to its own line below the row's buttons.
                <div className="order-last w-full border-t border-gray-100 pt-3">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                        <QueueFilterField label="Stage">
                            <select value={values.stage} onChange={(e) => onChange("stage", e.target.value)} className={QUEUE_SELECT_CLASS}>
                                <option value="">Any stage</option>
                                {Object.entries(ECOFY_STAGE_LABELS).map(([k, v]) => (
                                    <option key={k} value={k}>
                                        {k} · {v}
                                    </option>
                                ))}
                            </select>
                        </QueueFilterField>
                        <QueueFilterField label="Temperature">
                            <select value={values.temperature} onChange={(e) => onChange("temperature", e.target.value)} className={QUEUE_SELECT_CLASS}>
                                <option value="">Any temperature</option>
                                <option value="HOT">Hot</option>
                                <option value="WARM">Warm</option>
                            </select>
                        </QueueFilterField>
                        <QueueFilterField label="Segment">
                            <select value={values.segment} onChange={(e) => onChange("segment", e.target.value)} className={QUEUE_SELECT_CLASS}>
                                <option value="">Any segment</option>
                                {ECOFY_SEGMENTS.map((s) => (
                                    <option key={s} value={s}>
                                        {s === "CI" ? "C&I" : s}
                                    </option>
                                ))}
                            </select>
                        </QueueFilterField>
                        {showOwner && (
                            <QueueFilterField label="Owner">
                                <select value={values.assignee} onChange={(e) => onChange("assignee", e.target.value)} className={QUEUE_SELECT_CLASS}>
                                    <option value="">Anyone</option>
                                    <option value="none">Unassigned</option>
                                    {(assignees.data ?? []).map((a) => (
                                        <option key={a.id} value={a.id}>
                                            {a.name} ({ECOFY_ROLE_LABEL[a.role] ?? a.role})
                                        </option>
                                    ))}
                                </select>
                            </QueueFilterField>
                        )}
                    </div>
                    <div className="mt-3 flex justify-end">
                        <button
                            type="button"
                            onClick={onReset}
                            disabled={activeCount === 0}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Clear filters
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
