"use client";

/**
 * The filter bar the Inside Sales and ASM queues share.
 *
 * ONE COMPONENT FOR BOTH because both queues ask the same five questions —
 * which stage, how warm, where, and over what dates — and each adds its own on
 * top. The dashboard-specific selects come in through `children` rather than
 * through a prop per filter, so adding one to either queue never touches this
 * file, and the two bars cannot drift into looking like different products.
 *
 * BEHIND A DISCLOSURE, WITH A COUNT BADGE. Six selects permanently above a table
 * is more chrome than the table, but a filter that is silently narrowing the
 * list while invisible is the failure mode that actually costs people time — so
 * the trigger always says how many are doing work, and the reset is always one
 * click from wherever you are. Same split, same reason, as the /leads bar.
 *
 * The city select is NARROWED BY THE CHOSEN STATE, and clearing the state clears
 * the city with it: "Panipat" under no state is a filter whose meaning depends on
 * data the user cannot see.
 */

import { ChevronDown, RotateCcw, SlidersHorizontal } from "lucide-react";
import {
    countQueueFilters,
    INTEREST_OPTIONS,
    LEAD_STATUS_OPTIONS,
    type QueueFilters,
    type QueueRegion,
} from "@/lib/leads/queueFilters";

/** Styling only — width belongs to the grid cell, never to the control. */
export const QUEUE_SELECT_CLASS =
    "w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-700 outline-none transition-colors focus:border-gray-400";

const FIELD_LABEL_CLASS =
    "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400";

/** A labelled cell in the filter grid. Exported so callers can add their own. */
export function QueueFilterField({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <span className={FIELD_LABEL_CLASS}>{label}</span>
            {children}
        </div>
    );
}

type Props = {
    values: QueueFilters;
    /** One key at a time — the bar never needs to move two together. */
    onChange: (key: keyof QueueFilters, value: string) => void;
    onReset: () => void;
    open: boolean;
    onToggle: () => void;
    regions: QueueRegion[];
    /**
     * What the date range means on this queue — "Created" for the rep, "Visit
     * date" for the ASM. Spelled out because a bare "From / To" over two
     * different columns is the same control lying about two different things.
     */
    dateLabel: string;
    /** Dashboard-specific selects, rendered as further cells in the same grid. */
    children?: React.ReactNode;
    /** How many extra filters `children` contributes, for the badge. */
    extraActiveCount?: number;
};

export function QueueFilterBar({
    values,
    onChange,
    onReset,
    open,
    onToggle,
    regions,
    dateLabel,
    children,
    extraActiveCount = 0,
}: Props) {
    const activeCount = countQueueFilters(values) + extraActiveCount;
    const cities =
        regions.find((r) => r.state === values.state)?.cities ?? [];

    return (
        <>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                    activeCount > 0
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                }`}
            >
                <SlidersHorizontal className="h-4 w-4" />
                Filters
                {activeCount > 0 && (
                    <span className="rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold text-white">
                        {activeCount}
                    </span>
                )}
                <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
                />
            </button>

            {open && (
                // `order-last` + `w-full`: the trigger sits inline with the
                // search box, but the panel drops to its own line BELOW the
                // row's action buttons rather than shoving them onto a third
                // line every time the filters are opened. Both rely on the
                // caller's row being a flex-wrap container, which is why this
                // component renders a fragment rather than its own box.
                <div className="order-last w-full border-t border-gray-100 pt-3">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                        <QueueFilterField label="Lead status">
                            <select
                                value={values.status}
                                onChange={(e) => onChange("status", e.target.value)}
                                className={QUEUE_SELECT_CLASS}
                            >
                                <option value="">Any status</option>
                                {LEAD_STATUS_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </QueueFilterField>

                        <QueueFilterField label="Interest">
                            <select
                                value={values.interest}
                                onChange={(e) => onChange("interest", e.target.value)}
                                className={QUEUE_SELECT_CLASS}
                            >
                                <option value="">Any interest</option>
                                {INTEREST_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </QueueFilterField>

                        <QueueFilterField label="State">
                            <select
                                value={values.state}
                                onChange={(e) => {
                                    onChange("state", e.target.value);
                                    // The city goes with it. A city left behind
                                    // from the previous state ANDs with the new
                                    // one and matches nothing — an empty table
                                    // caused by a filter the user thought they
                                    // had just changed.
                                    if (values.city) onChange("city", "");
                                }}
                                className={QUEUE_SELECT_CLASS}
                            >
                                <option value="">Any state</option>
                                {regions.map((r) => (
                                    <option key={r.state} value={r.state}>
                                        {r.state}
                                    </option>
                                ))}
                            </select>
                        </QueueFilterField>

                        <QueueFilterField label="City">
                            <select
                                value={values.city}
                                onChange={(e) => onChange("city", e.target.value)}
                                // A city list with no state chosen would be every
                                // city in the queue, and picking one of those is a
                                // filter whose meaning the user cannot see.
                                disabled={!values.state}
                                className={`${QUEUE_SELECT_CLASS} disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400`}
                                title={
                                    values.state
                                        ? undefined
                                        : "Choose a state first"
                                }
                            >
                                <option value="">
                                    {values.state ? "Any city" : "Choose a state first"}
                                </option>
                                {cities.map((c) => (
                                    <option key={c} value={c}>
                                        {c}
                                    </option>
                                ))}
                            </select>
                        </QueueFilterField>

                        <QueueFilterField label={`${dateLabel} from`}>
                            <input
                                type="date"
                                value={values.from}
                                // Never after the other end. A range with the ends
                                // crossed matches nothing, and an empty table with
                                // no explanation reads as a broken screen.
                                max={values.to || undefined}
                                onChange={(e) => onChange("from", e.target.value)}
                                className={QUEUE_SELECT_CLASS}
                            />
                        </QueueFilterField>

                        <QueueFilterField label={`${dateLabel} to`}>
                            <input
                                type="date"
                                value={values.to}
                                min={values.from || undefined}
                                onChange={(e) => onChange("to", e.target.value)}
                                className={QUEUE_SELECT_CLASS}
                            />
                        </QueueFilterField>

                        {children}
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
