"use client";

// Filter bar for the merged Leads tab.
//
// Nine filters is a lot to put in front of someone, so the split is deliberate:
// the four people change constantly (search, qualification, intent, owner) plus
// the date range stay on top; the drill-downs (ASM, source, state, city, has
// phone) sit behind "More filters" with a COUNT BADGE — a hidden filter that is
// silently narrowing the list is the failure mode this layout has to avoid.

import { ChevronDown, RotateCcw, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { LEAD_STATUS } from "@/lib/lifecycle/transitions";
import { UNASSIGNED_FILTER } from "@/lib/admin/leadsInfoFilters";
import {
    INTENT_BUCKET_LABEL,
    INTENT_BUCKET_OPTIONS,
    INTENT_BUCKET_RANGE,
} from "@/lib/leads/intentBucket";
import type { LeadsCapabilities } from "@/lib/leads/access";
import type { LeadListFacets } from "@/lib/leads/leadListQuery";
import {
    countSecondary,
    hasAnyFilter,
    type LeadFilters,
} from "./filters";

function pretty(value: string | null | undefined): string {
    if (!value) return "—";
    return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const SELECT_CLASS =
    "w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-700 outline-none transition-colors focus:border-gray-400";

type Props = {
    draft: LeadFilters;
    onChange: (key: keyof LeadFilters, value: string | boolean) => void;
    onClear: () => void;
    facets: LeadListFacets | undefined;
    caps: LeadsCapabilities;
    showMore: boolean;
    onToggleMore: () => void;
    /** Set both ends of the created range at once (month presets). */
    onDateRange: (from: string, to: string) => void;
    busy?: boolean;
};

export function LeadsFilterBar({
    draft,
    onChange,
    onClear,
    facets,
    caps,
    showMore,
    onToggleMore,
    onDateRange,
    busy,
}: Props) {
    const moreCount = countSecondary(draft);

    // "This month" / "Last month" — offset 0 and -1. Ported from the date row
    // the Leads tab used before the merge.
    const applyMonthPreset = (offset: number) => {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
        const iso = (d: Date) =>
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
                d.getDate(),
            ).padStart(2, "0")}`;
        onDateRange(iso(start), iso(end));
    };

    return (
        <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
            {/* ── Primary row ── */}
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[220px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <Input
                        value={draft.search}
                        onChange={(e) => onChange("search", e.target.value)}
                        placeholder="Search by dealer, shop, phone or city…"
                        className="pl-9"
                    />
                </div>

                {/* Qualification = the BRD §0.7 pipeline stage. */}
                <select
                    aria-label="Qualification"
                    className={`${SELECT_CLASS} w-auto min-w-[170px]`}
                    value={draft.status}
                    onChange={(e) => onChange("status", e.target.value)}
                >
                    <option value="">All qualifications</option>
                    {/* "Unassigned" means no current owner (any/no status), not
                        the New_Unassigned lead_status — see leadsInfoFilters.ts. */}
                    <option value={UNASSIGNED_FILTER}>Unassigned</option>
                    {LEAD_STATUS.filter((s) => s !== "New_Unassigned").map((s) => (
                        <option key={s} value={s}>
                            {pretty(s)}
                        </option>
                    ))}
                </select>

                <select
                    aria-label="Intent"
                    className={`${SELECT_CLASS} w-auto min-w-[150px]`}
                    value={draft.intent}
                    onChange={(e) => onChange("intent", e.target.value)}
                >
                    <option value="">All intent</option>
                    {INTENT_BUCKET_OPTIONS.map((b) => (
                        <option key={b} value={b}>
                            {INTENT_BUCKET_LABEL[b]} ({INTENT_BUCKET_RANGE[b]})
                        </option>
                    ))}
                </select>

                {caps.canSeeOwnerAsm && (
                    <select
                        aria-label="Owner"
                        className={`${SELECT_CLASS} w-auto min-w-[160px]`}
                        value={draft.ownerId}
                        onChange={(e) => onChange("ownerId", e.target.value)}
                    >
                        <option value="">All owners</option>
                        {(facets?.owners ?? []).map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.name ?? "Unnamed"}
                                {o.role ? ` · ${pretty(o.role)}` : ""}
                            </option>
                        ))}
                    </select>
                )}

                <button
                    type="button"
                    onClick={onToggleMore}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                        moreCount > 0
                            ? "border-gray-900 bg-gray-900 text-white"
                            : "border-gray-200 bg-white text-gray-600 hover:border-gray-400"
                    }`}
                >
                    More filters
                    {moreCount > 0 && (
                        <span className="rounded-full bg-white/20 px-1.5 text-[11px] tabular-nums">
                            {moreCount}
                        </span>
                    )}
                    <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${showMore ? "rotate-180" : ""}`}
                    />
                </button>

                {hasAnyFilter(draft) && (
                    <button
                        type="button"
                        onClick={onClear}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-50"
                    >
                        <RotateCcw className="h-3.5 w-3.5" /> Clear
                    </button>
                )}

                {busy && (
                    <span className="h-2 w-2 animate-pulse rounded-full bg-gray-400" />
                )}
            </div>

            {/* ── Created-date range ── */}
            <div className="flex flex-wrap items-center gap-2">
                <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                    Created
                </span>
                <div className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 transition-colors focus-within:border-gray-400">
                    <input
                        type="date"
                        value={draft.from}
                        max={draft.to || undefined}
                        onChange={(e) => onChange("from", e.target.value)}
                        aria-label="From (lead created date)"
                        className="bg-transparent text-sm text-gray-700 outline-none"
                    />
                    <span className="text-gray-300">–</span>
                    <input
                        type="date"
                        value={draft.to}
                        min={draft.from || undefined}
                        onChange={(e) => onChange("to", e.target.value)}
                        aria-label="To (lead created date)"
                        className="bg-transparent text-sm text-gray-700 outline-none"
                    />
                </div>
                <button
                    type="button"
                    onClick={() => applyMonthPreset(0)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-gray-400 hover:text-gray-900"
                >
                    This month
                </button>
                <button
                    type="button"
                    onClick={() => applyMonthPreset(-1)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-gray-400 hover:text-gray-900"
                >
                    Last month
                </button>
                {(draft.from || draft.to) && (
                    <button
                        type="button"
                        onClick={() => onDateRange("", "")}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-50"
                    >
                        <X className="h-3.5 w-3.5" /> Clear dates
                    </button>
                )}
            </div>

            {/* ── More filters ── */}
            {showMore && (
                <div className="grid grid-cols-2 gap-3 border-t border-gray-100 pt-3 md:grid-cols-4">
                    {caps.canSeeOwnerAsm && (
                        <select
                            aria-label="ASM"
                            className={SELECT_CLASS}
                            value={draft.asmId}
                            onChange={(e) => onChange("asmId", e.target.value)}
                        >
                            <option value="">All ASMs</option>
                            {(facets?.asms ?? []).map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.name ?? "Unnamed"}
                                </option>
                            ))}
                        </select>
                    )}
                    <select
                        aria-label="Source"
                        className={SELECT_CLASS}
                        value={draft.source}
                        onChange={(e) => onChange("source", e.target.value)}
                    >
                        <option value="">All sources</option>
                        {(facets?.sources ?? []).map((s) => (
                            <option key={s} value={s}>
                                {pretty(s)}
                            </option>
                        ))}
                    </select>
                    <Input
                        value={draft.state}
                        onChange={(e) => onChange("state", e.target.value)}
                        placeholder="State"
                    />
                    <Input
                        value={draft.city}
                        onChange={(e) => onChange("city", e.target.value)}
                        placeholder="City"
                    />
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-600">
                        <input
                            type="checkbox"
                            checked={draft.hasPhone}
                            onChange={(e) => onChange("hasPhone", e.target.checked)}
                            className="h-4 w-4 cursor-pointer rounded border-gray-300 accent-gray-900"
                        />
                        Has phone only
                    </label>
                </div>
            )}
        </div>
    );
}
