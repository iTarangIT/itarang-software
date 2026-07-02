"use client";

// Admin / Sales-Head "Leads Info" oversight table. Lists every lead in the
// inside-sales + ASM pipeline with filters. Clicking a row opens the
// ManageLeadDrawer for in-place reassignment — no navigation away from this
// page (the /inside-sales/lead/[id] route is gated by middleware that bounces
// non-rep roles back to their own dashboard).

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    AlertTriangle,
    ChevronLeft,
    ChevronRight,
    Inbox,
    Loader2,
    Phone,
    RotateCcw,
    Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/app/(dashboard)/inside-sales/_components/StatusChip";
import { InterestChip } from "@/app/(dashboard)/inside-sales/_components/InterestChip";
import { IntentBadge } from "@/app/(dashboard)/inside-sales/_components/IntentBadge";
import { LEAD_STATUS, type LeadStatus } from "@/lib/lifecycle/transitions";
import { VISIT_OUTCOME_LABELS, type VisitOutcome } from "@/lib/asm/types";
import type { LeadsInfoFacets, LeadsInfoRow } from "@/lib/admin/leadsInfoQuery";
import { UNASSIGNED_FILTER } from "@/lib/admin/leadsInfoFilters";
import { BulkActionBar } from "@/app/(dashboard)/admin/_components/BulkActionBar";
import { ManageLeadDrawer } from "./ManageLeadDrawer";

const PAGE_SIZE = 25;

type Draft = {
    status: string;
    ownerId: string;
    asmId: string;
    source: string;
    state: string;
    city: string;
    search: string;
};

const EMPTY: Draft = {
    status: "",
    ownerId: "",
    asmId: "",
    source: "",
    state: "",
    city: "",
    search: "",
};

type ApiData = {
    rows: LeadsInfoRow[];
    total: number;
    page: number;
    limit: number;
    facets: LeadsInfoFacets;
};

// Outcome chip tone — kept at the same chip baseline as every other chip in
// the table (text-[11px] font-medium) so the row reads as one consistent set.
const OUTCOME_TONE: Record<VisitOutcome, string> = {
    productive: "bg-emerald-50 text-emerald-700 border-emerald-200",
    commercials_progressed: "bg-sky-50 text-sky-700 border-sky-200",
    dealer_not_present: "bg-gray-50 text-gray-600 border-gray-200",
    dealer_uninterested: "bg-rose-50 text-rose-700 border-rose-200",
    scheduling_issue: "bg-amber-50 text-amber-700 border-amber-200",
    other: "bg-gray-50 text-gray-600 border-gray-200",
};

const CHIP_BASE =
    "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap";

function pretty(value: string | null | undefined): string {
    if (!value) return "—";
    return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDateTime(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleDateString("en-IN", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "short",
            day: "2-digit",
        });
    } catch {
        return "—";
    }
}

function selectClass() {
    return "w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm";
}

export function LeadsInfoView() {
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [applied, setApplied] = useState<Draft>(EMPTY);
    const [page, setPage] = useState(1);
    const [selectedLead, setSelectedLead] = useState<LeadsInfoRow | null>(null);
    // Bulk-action selection — lead ids ticked on the current page.
    const [selected, setSelected] = useState<Set<string>>(new Set());

    // Debounce draft → applied so typing doesn't refetch on every keystroke.
    // Any filter change snaps back to page 1 and drops the selection — acting on
    // a stale id from another page/filter would silently hit the wrong lead.
    useEffect(() => {
        const t = window.setTimeout(() => {
            setApplied(draft);
            setPage(1);
            setSelected(new Set());
        }, 350);
        return () => window.clearTimeout(t);
    }, [draft]);

    // Changing page also clears the selection (see above).
    const goToPage = (updater: (p: number) => number) => {
        setPage(updater);
        setSelected(new Set());
    };

    const toggle = (id: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const set = (key: keyof Draft, value: string) =>
        setDraft((d) => ({ ...d, [key]: value }));

    const query = useQuery<{ success: true; data: ApiData }>({
        queryKey: ["admin-leads-info", applied, page],
        queryFn: async () => {
            const u = new URL("/api/admin/leads-info", window.location.origin);
            u.searchParams.set("page", String(page));
            u.searchParams.set("limit", String(PAGE_SIZE));
            if (applied.status) u.searchParams.set("status", applied.status);
            if (applied.ownerId) u.searchParams.set("owner_id", applied.ownerId);
            if (applied.asmId) u.searchParams.set("asm_id", applied.asmId);
            if (applied.source) u.searchParams.set("source", applied.source);
            if (applied.state) u.searchParams.set("state", applied.state);
            if (applied.city) u.searchParams.set("city", applied.city);
            if (applied.search) u.searchParams.set("search", applied.search);
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load leads");
            return res.json();
        },
    });

    const data = query.data?.data;
    const rows = data?.rows ?? [];
    const allOnPageSelected =
        rows.length > 0 && rows.every((r) => selected.has(r.id));
    const toggleAllOnPage = () =>
        setSelected((prev) => {
            if (rows.length > 0 && rows.every((r) => prev.has(r.id))) {
                const next = new Set(prev);
                rows.forEach((r) => next.delete(r.id));
                return next;
            }
            const next = new Set(prev);
            rows.forEach((r) => next.add(r.id));
            return next;
        });
    const total = data?.total ?? 0;
    const facets = data?.facets;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, total);
    const hasFilters = (Object.keys(EMPTY) as (keyof Draft)[]).some(
        (k) => draft[k] !== "",
    );

    return (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
            {/* Filter bar */}
            <div className="border-b border-gray-100 p-4 space-y-3">
                <div className="flex items-center gap-3">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                        <Input
                            value={draft.search}
                            onChange={(e) => set("search", e.target.value)}
                            placeholder="Search by dealer, shop, or phone…"
                            className="pl-9"
                        />
                    </div>
                    {query.isFetching && (
                        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                    )}
                    {selected.size > 0 && (
                        <BulkActionBar
                            selectedIds={[...selected]}
                            onClear={() => setSelected(new Set())}
                            onActionDone={() => {
                                setSelected(new Set());
                                queryClient.invalidateQueries({
                                    queryKey: ["admin-leads-info"],
                                });
                            }}
                        />
                    )}
                    {hasFilters && (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setDraft(EMPTY)}
                            className="inline-flex items-center gap-1.5"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Clear
                        </Button>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                    <select
                        className={selectClass()}
                        value={draft.status}
                        onChange={(e) => set("status", e.target.value)}
                    >
                        <option value="">All statuses</option>
                        {/* "Unassigned" = no current owner (any/no status), not
                            just the New_Unassigned lead_status. */}
                        <option value={UNASSIGNED_FILTER}>Unassigned</option>
                        {LEAD_STATUS.filter((s) => s !== "New_Unassigned").map(
                            (s) => (
                                <option key={s} value={s}>
                                    {pretty(s)}
                                </option>
                            ),
                        )}
                    </select>

                    <select
                        className={selectClass()}
                        value={draft.ownerId}
                        onChange={(e) => set("ownerId", e.target.value)}
                    >
                        <option value="">All owners</option>
                        {(facets?.owners ?? []).map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.name ?? "Unnamed"}
                                {o.role ? ` · ${pretty(o.role)}` : ""}
                            </option>
                        ))}
                    </select>

                    <select
                        className={selectClass()}
                        value={draft.asmId}
                        onChange={(e) => set("asmId", e.target.value)}
                    >
                        <option value="">All ASMs</option>
                        {(facets?.asms ?? []).map((a) => (
                            <option key={a.id} value={a.id}>
                                {a.name ?? "Unnamed"}
                            </option>
                        ))}
                    </select>

                    <select
                        className={selectClass()}
                        value={draft.source}
                        onChange={(e) => set("source", e.target.value)}
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
                        onChange={(e) => set("state", e.target.value)}
                        placeholder="State"
                    />
                    <Input
                        value={draft.city}
                        onChange={(e) => set("city", e.target.value)}
                        placeholder="City"
                    />
                </div>
            </div>

            {/* Table */}
            {query.error && (
                <div className="flex items-center gap-2 bg-rose-50/50 px-4 py-6 text-sm text-rose-700">
                    <AlertTriangle className="h-4 w-4" />
                    {(query.error as Error).message}
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-gray-50/60 text-[11px] uppercase tracking-wide text-gray-500">
                        <tr className="align-middle">
                            <th className="w-10 px-4 py-3 text-left font-semibold">
                                <input
                                    type="checkbox"
                                    aria-label="Select all on this page"
                                    checked={allOnPageSelected}
                                    onChange={toggleAllOnPage}
                                    className="cursor-pointer"
                                />
                            </th>
                            <th className="min-w-[220px] px-4 py-3 text-left font-semibold">
                                Dealer / Shop
                            </th>
                            <th className="min-w-[140px] px-4 py-3 text-left font-semibold">
                                Phone
                            </th>
                            <th className="min-w-[140px] px-4 py-3 text-left font-semibold">
                                Region
                            </th>
                            <th className="min-w-[130px] px-4 py-3 text-left font-semibold">
                                Status
                            </th>
                            <th className="min-w-[90px] px-4 py-3 text-left font-semibold">
                                Source
                            </th>
                            <th className="min-w-[180px] px-4 py-3 text-left font-semibold">
                                Owner
                            </th>
                            <th className="min-w-[140px] px-4 py-3 text-left font-semibold">
                                ASM
                            </th>
                            <th className="min-w-[140px] px-4 py-3 text-left font-semibold">
                                Visit / Outcome
                            </th>
                            <th className="min-w-[130px] px-4 py-3 text-left font-semibold">
                                Interest / AI
                            </th>
                            <th className="min-w-[120px] px-4 py-3 text-left font-semibold">
                                Last Touch
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {query.isLoading && (
                            <tr>
                                <td colSpan={11} className="px-4 py-12 text-center text-gray-400">
                                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                                    Loading leads…
                                </td>
                            </tr>
                        )}
                        {!query.isLoading && rows.length === 0 && (
                            <tr>
                                <td colSpan={11} className="px-4 py-16 text-center text-gray-400">
                                    <Inbox className="mx-auto mb-2 h-8 w-8" />
                                    {hasFilters
                                        ? "No leads match these filters."
                                        : "No leads yet."}
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => {
                            const outcome = row.visit_outcome as VisitOutcome | null;
                            return (
                                <tr
                                    key={row.id}
                                    onClick={() => setSelectedLead(row)}
                                    className="cursor-pointer border-l-2 border-transparent align-middle transition hover:border-emerald-500 hover:bg-gray-50"
                                >
                                    <td
                                        className="px-4 py-3 align-middle"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <input
                                            type="checkbox"
                                            aria-label={`Select ${row.dealer_name || row.shop_name || "lead"}`}
                                            checked={selected.has(row.id)}
                                            onChange={() => toggle(row.id)}
                                            className="cursor-pointer"
                                        />
                                    </td>
                                    <td className="px-4 py-3 align-middle">
                                        <div className="font-medium text-gray-900">
                                            {row.dealer_name || row.shop_name || "(unnamed dealer)"}
                                        </div>
                                        {row.shop_name && row.dealer_name && (
                                            <div className="mt-0.5 text-[11px] text-gray-500">
                                                {row.shop_name}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-middle text-gray-700 tabular-nums">
                                        <span className="inline-flex items-center gap-1">
                                            <Phone className="h-3 w-3 text-gray-400" />
                                            {row.phone || "—"}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 align-middle">
                                        <div className="text-sm font-medium text-gray-900">
                                            {row.city || "—"}
                                        </div>
                                        {row.state && (
                                            <div className="text-[11px] capitalize text-gray-500">
                                                {row.state.toLowerCase()}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-middle">
                                        <StatusChip status={row.lead_status as LeadStatus | null} />
                                    </td>
                                    <td className="px-4 py-3 align-middle text-[11px] text-gray-700">
                                        {pretty(row.source)}
                                    </td>
                                    <td className="px-4 py-3 align-middle">
                                        {row.current_owner_name ? (
                                            <div className="space-y-1">
                                                <div className="text-sm text-gray-800">
                                                    {row.current_owner_name}
                                                </div>
                                                {row.current_owner_role && (
                                                    <span className={`${CHIP_BASE} border-gray-200 bg-gray-50 text-gray-600`}>
                                                        {pretty(row.current_owner_role)}
                                                    </span>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="text-[11px] italic text-gray-400">
                                                Unassigned
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-middle text-sm text-gray-700">
                                        {row.asm_name || (
                                            <span className="text-[11px] italic text-gray-400">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-middle">
                                        {row.visit_status ? (
                                            <div className="space-y-1">
                                                <div className="text-[11px] text-gray-600">
                                                    {pretty(row.visit_status)}
                                                </div>
                                                {outcome ? (
                                                    <span className={`${CHIP_BASE} ${OUTCOME_TONE[outcome]}`}>
                                                        {VISIT_OUTCOME_LABELS[outcome]}
                                                    </span>
                                                ) : (
                                                    <span className="text-[11px] text-gray-400">
                                                        —
                                                    </span>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="text-[11px] italic text-gray-400">
                                                No visit
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-middle">
                                        <div className="flex flex-col items-start gap-1">
                                            <InterestChip level={row.interest_level} />
                                            <IntentBadge score={row.final_intent_score} size="sm" />
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-middle text-[11px] text-gray-600 tabular-nums">
                                        {fmtDateTime(row.last_touchpoint_at)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
                <span className="text-[11px] tabular-nums text-gray-500">
                    {total === 0
                        ? "0 results"
                        : `Showing ${start}–${end} of ${total.toLocaleString("en-IN")}`}
                </span>
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => goToPage((p) => Math.max(1, p - 1))}
                        disabled={page <= 1 || query.isFetching}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-[11px] tabular-nums text-gray-600">
                        Page {page} / {totalPages}
                    </span>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => goToPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages || query.isFetching}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <ManageLeadDrawer
                lead={selectedLead}
                onClose={() => setSelectedLead(null)}
            />
        </div>
    );
}
