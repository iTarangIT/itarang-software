"use client";

// Filter bar for the merged Leads tab.
//
// A dozen filters is a lot to put in front of someone, so the split is
// deliberate: the four people change constantly (search, qualification, intent,
// owner) plus the date range stay on top; the drill-downs (ASM, source, state,
// city, has phone) and the three-level call disposition sit behind "More
// filters" with a COUNT BADGE — a hidden filter that is silently narrowing the
// list is the failure mode this layout has to avoid.

import { ChevronDown, RotateCcw, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { LEAD_STATUS } from "@/lib/lifecycle/transitions";
import { UNASSIGNED_FILTER } from "@/lib/admin/leadsInfoFilters";
import {
    INTENT_BUCKET_LABEL,
    INTENT_BUCKET_OPTIONS,
    INTENT_BUCKET_RANGE,
    INTENT_SCORE_MAX,
    INTENT_SCORE_MIN,
} from "@/lib/leads/intentBucket";
import {
    CONNECTED_DISPOSITIONS,
    CONNECT_STATUS,
    CONNECT_STATUS_LABEL,
    DISPOSITION_BUCKETS,
    NOT_CONNECTED_REASONS,
    isKnownDisposition,
} from "@/lib/leads/dispositions";
import type { LeadsCapabilities } from "@/lib/leads/access";
// ⚠ TYPE-ONLY from leadListQuery — it imports `db`, and a VALUE import here
// drags the postgres driver into the browser bundle ("Can't resolve 'fs'").
// Runtime campaign constants come from the dependency-free module instead.
import type { LeadListFacets } from "@/lib/leads/leadListQuery";
import type { CampaignFacet } from "@/lib/leads/leadCampaign";
// Client-safe (regionSummary.ts has no imports at all) and shared with
// campaigns-table.tsx, so the two lists can never drift apart.
import { displayCampaignName } from "@/lib/leads/regionSummary";
import {
    CAMPAIGN_NONE,
    CAMPAIGN_SYSTEMS,
    CAMPAIGN_SYSTEM_LABEL,
} from "@/lib/leads/campaign";
import { IDLE_RANGES, IDLE_RANGE_KEYS } from "@/lib/leads/idle";
import {
    countSecondary,
    hasAnyFilter,
    type LeadFilters,
} from "./filters";

/**
 * The campaign's label, EXACTLY as the Campaigns tab renders it.
 *
 * Deliberately the same `displayCampaignName` call that campaigns-table.tsx
 * makes, on the same (client) side. Two reasons it is not just `c.name`:
 *
 *  - For AI-dialer campaigns `dialer_campaigns.name` is a frozen value that
 *    predates the region-shape fix, so the Campaigns tab ignores it and derives
 *    the title from category + region + start time. Using the stored name here
 *    meant one campaign appeared under two different names on two tabs, which
 *    is indistinguishable from the campaign being missing.
 *  - Formatting on the client keeps the timestamp in the VIEWER's timezone.
 *    Composing it on a UTC server would print every label 5.5 hours off what
 *    the tab shows.
 *
 * NeoDove campaigns are named by a human at creation, so their stored name is
 * authoritative — matching the `isNeodove ? c.name : …` branch in that table.
 */
function campaignLabel(c: CampaignFacet): string {
    if (c.system === "neodove") return c.name;
    return displayCampaignName({
        category: c.category,
        regionFilter: c.region_filter,
        startedAt: c.started_at,
    });
}

function pretty(value: string | null | undefined): string {
    if (!value) return "—";
    return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Styling ONLY — deliberately carries no width.
//
// It used to start with `w-full`, and the primary-row call sites appended
// `w-auto` to override it. That does not work: both are width utilities in the
// same layer, so the STYLESHEET order decides which wins, not the order they
// appear in the class attribute — and `w-full` is emitted last. Every select in
// the top row was therefore full-width and wrapped onto a line of its own.
// Width now belongs to the call site, which is the only place that knows
// whether the select sits in a flex row or a grid cell.
const SELECT_CLASS =
    "rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-700 outline-none transition-colors focus:border-gray-400";


type Props = {
    draft: LeadFilters;
    onChange: (key: keyof LeadFilters, value: string) => void;
    /** Set several filters at once — the disposition levels have to move together. */
    onPatch: (patch: Partial<LeadFilters>) => void;
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
    onPatch,
    onClear,
    facets,
    caps,
    showMore,
    onToggleMore,
    onDateRange,
    busy,
}: Props) {
    const moreCount = countSecondary(draft);

    // Dispositions present in the data but NOT in the CC sheet — a campaign
    // configured with NeoDove's stock vocabulary, or a value added in their
    // settings since. They are filterable and must be offered, but grouped
    // apart so the sheet stays recognisable as the sheet.
    const extraDispositions = (facets?.dispositions ?? [])
        .map((d) => d.value)
        .filter((v) => !isKnownDisposition(v));

    // ── Intent: bucket and exact range are one axis, so they replace each
    // other. Same principle as the disposition cascade below — the UI must not
    // let someone build a combination that can only return nothing.
    const setIntentBucket = (value: string) =>
        onPatch({
            intent: value as LeadFilters["intent"],
            scoreMin: "",
            scoreMax: "",
        });

    const setScore = (key: "scoreMin" | "scoreMax", value: string) =>
        onPatch({
            [key]: value,
            // Clearing the last populated box must NOT also clear the bucket —
            // that would make deleting a digit silently drop an unrelated
            // filter. Only a range that is actually being expressed wins.
            ...(value ? { intent: "" as const } : {}),
        });

    // Picking a level clears the narrower ones, so the three selects can never
    // encode an impossible combination — "Not Connected + Hot" would return
    // nothing and look like a bug rather than a contradiction.
    const setConnectStatus = (value: string) =>
        onPatch({
            connectStatus: value as LeadFilters["connectStatus"],
            dispositionBucket: "",
            disposition: "",
        });
    const setBucket = (value: string) =>
        onPatch({
            dispositionBucket: value as LeadFilters["dispositionBucket"],
            disposition: "",
        });

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
            {/* ── Search ──
                On its own row. It was in the same flex line as the three
                selects with `flex-1 min-w-[220px]`, so it ate the free space and
                pushed everything after it onto separate lines. */}
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                    value={draft.search}
                    onChange={(e) => onChange("search", e.target.value)}
                    placeholder="Search by dealer, shop, phone or city…"
                    className="pl-9"
                />
            </div>

            {/* ── Qualification · Intent · Owner · More filters, one row ── */}
            <div className="flex flex-wrap items-center gap-2">
                {/* Qualification = the BRD §0.7 pipeline stage. */}
                <select
                    aria-label="Qualification"
                    className={`${SELECT_CLASS} min-w-[150px] flex-1`}
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
                    className={`${SELECT_CLASS} min-w-[150px] flex-1`}
                    value={draft.intent}
                    onChange={(e) => setIntentBucket(e.target.value)}
                >
                    <option value="">All intent</option>
                    {INTENT_BUCKET_OPTIONS.map((b) => (
                        <option key={b} value={b}>
                            {INTENT_BUCKET_LABEL[b]} ({INTENT_BUCKET_RANGE[b]})
                        </option>
                    ))}
                </select>

                {/* Exact score range — the same axis as the bucket above, which
                    is why picking either one clears the other. A bucket IS a
                    range, so holding both can only ever be redundant (Hot +
                    75–100) or a contradiction (Hot + 0–30) that returns nothing
                    and reads as a broken filter. */}
                <div
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 transition-colors focus-within:border-gray-400"
                    title={`Filter by exact intent score (${INTENT_SCORE_MIN}–${INTENT_SCORE_MAX}). Overrides the bucket.`}
                >
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                        Score
                    </span>
                    <input
                        type="number"
                        inputMode="numeric"
                        aria-label="Minimum intent score"
                        placeholder="min"
                        min={INTENT_SCORE_MIN}
                        max={INTENT_SCORE_MAX}
                        value={draft.scoreMin}
                        onChange={(e) => setScore("scoreMin", e.target.value)}
                        className="w-14 bg-transparent text-sm text-gray-700 outline-none"
                    />
                    <span className="text-gray-300">–</span>
                    <input
                        type="number"
                        inputMode="numeric"
                        aria-label="Maximum intent score"
                        placeholder="max"
                        min={INTENT_SCORE_MIN}
                        max={INTENT_SCORE_MAX}
                        value={draft.scoreMax}
                        onChange={(e) => setScore("scoreMax", e.target.value)}
                        className="w-14 bg-transparent text-sm text-gray-700 outline-none"
                    />
                    {(draft.scoreMin || draft.scoreMax) && (
                        <button
                            type="button"
                            onClick={() => onPatch({ scoreMin: "", scoreMax: "" })}
                            aria-label="Clear score range"
                            className="rounded p-0.5 text-gray-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    )}
                </div>

                {caps.canSeeOwnerAsm && (
                    <select
                        aria-label="Owner"
                        className={`${SELECT_CLASS} min-w-[150px] flex-1`}
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

                {/* NeoDove — a toggle in the PRIMARY row, not an option in the
                    "Source" select behind More filters. Two reasons: it is not a
                    source (a scraped lead we pushed keeps source = 'scraper', so
                    the select would answer a different question), and it removes
                    most of the list when on, which is exactly the kind of filter
                    the layout comment above says must never be hidden. */}
                <button
                    type="button"
                    onClick={() => onChange("neodove", draft.neodove ? "" : "1")}
                    aria-pressed={draft.neodove === "1"}
                    title={
                        draft.neodove
                            ? "Showing only leads handed to the NeoDove calling team — click to show all"
                            : "Show only leads handed to the NeoDove calling team"
                    }
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                        draft.neodove
                            ? "border-sky-300 bg-sky-50 text-sky-700"
                            : "border-gray-200 bg-white text-gray-600 hover:border-gray-400"
                    }`}
                >
                    <span
                        aria-hidden
                        className={`h-1.5 w-1.5 rounded-full ${
                            draft.neodove ? "bg-sky-500" : "bg-gray-300"
                        }`}
                    />
                    NeoDove
                </button>

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
                            className={`${SELECT_CLASS} w-full`}
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
                        className={`${SELECT_CLASS} w-full`}
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
                    {/* Idle band — the same thresholds the Idle column colours by,
                        so a filtered list looks coherent rather than being an
                        arbitrary slice through the ramp. */}
                    <select
                        aria-label="Idle"
                        className={`${SELECT_CLASS} w-full`}
                        value={draft.idle}
                        onChange={(e) => onChange("idle", e.target.value)}
                    >
                        <option value="">Any idle time</option>
                        {IDLE_RANGE_KEYS.map((k) => (
                            <option key={k} value={k}>
                                {IDLE_RANGES[k].label}
                            </option>
                        ))}
                    </select>
                    {/* Campaign — both systems in one control, grouped. Only
                        campaigns that actually have leads are offered. */}
                    <select
                        aria-label="Campaign"
                        className={`${SELECT_CLASS} w-full`}
                        value={draft.campaign}
                        onChange={(e) => onChange("campaign", e.target.value)}
                    >
                        <option value="">All campaigns</option>
                        <option value={CAMPAIGN_NONE}>Not in a campaign</option>
                        {CAMPAIGN_SYSTEMS.map((system) => {
                            const items = (facets?.campaigns ?? []).filter(
                                (c) => c.system === system,
                            );
                            if (!items.length) return null;
                            return (
                                <optgroup
                                    key={system}
                                    label={CAMPAIGN_SYSTEM_LABEL[system]}
                                >
                                    {items.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {campaignLabel(c)} ({c.lead_count})
                                        </option>
                                    ))}
                                </optgroup>
                            );
                        })}
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
                    {/* ── Call disposition, L1 → L2 → L3 (E-236) ──
                        Its own row: three selects that narrow each other read as
                        one control, and interleaving them with the unrelated
                        drill-downs above made the cascade invisible. */}
                    <div className="col-span-2 space-y-2 border-t border-gray-100 pt-3 md:col-span-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                            Call disposition
                        </p>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                            <select
                                aria-label="Call outcome"
                                className={`${SELECT_CLASS} w-full`}
                                value={draft.connectStatus}
                                onChange={(e) => setConnectStatus(e.target.value)}
                            >
                                <option value="">Any call outcome</option>
                                {CONNECT_STATUS.map((s) => (
                                    <option key={s} value={s}>
                                        {CONNECT_STATUS_LABEL[s]}
                                    </option>
                                ))}
                            </select>

                            {/* Hidden, not disabled, when the call did not connect:
                                the sheet gives those reasons no bucket at all, so
                                there is nothing to choose rather than nothing
                                currently choosable. */}
                            {draft.connectStatus !== "not_connected" && (
                                <select
                                    aria-label="Disposition bucket"
                                    className={`${SELECT_CLASS} w-full`}
                                    value={draft.dispositionBucket}
                                    onChange={(e) => setBucket(e.target.value)}
                                >
                                    <option value="">Any bucket</option>
                                    {DISPOSITION_BUCKETS.map((b) => (
                                        <option key={b} value={b}>
                                            {b}
                                        </option>
                                    ))}
                                </select>
                            )}

                            <select
                                aria-label="Disposition"
                                className={`${SELECT_CLASS} col-span-2 w-full`}
                                value={draft.disposition}
                                onChange={(e) => onChange("disposition", e.target.value)}
                            >
                                <option value="">Any disposition</option>

                                {draft.connectStatus !== "not_connected" &&
                                    DISPOSITION_BUCKETS.filter(
                                        (b) =>
                                            !draft.dispositionBucket ||
                                            draft.dispositionBucket === b,
                                    ).map((b) => (
                                        <optgroup key={b} label={`Connected › ${b}`}>
                                            {CONNECTED_DISPOSITIONS[b].map((d) => (
                                                <option key={`${b}:${d}`} value={d}>
                                                    {d}
                                                </option>
                                            ))}
                                        </optgroup>
                                    ))}

                                {/* A bucket is a CONNECTED concept, so once one is
                                    picked the not-connected reasons cannot apply. */}
                                {draft.connectStatus !== "connected" &&
                                    !draft.dispositionBucket && (
                                        <optgroup label="Not connected">
                                            {NOT_CONNECTED_REASONS.map((d) => (
                                                <option key={d} value={d}>
                                                    {d}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}

                                {extraDispositions.length > 0 &&
                                    !draft.dispositionBucket && (
                                        <optgroup label="Other (seen in NeoDove)">
                                            {extraDispositions.map((d) => (
                                                <option key={d} value={d}>
                                                    {d}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                            </select>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
