"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Search, Loader2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateLeadModal } from "@/app/(dashboard)/inside-sales/_components/modals/CreateLeadModal";
import {
    QueueFilterBar,
    QueueFilterField,
    QUEUE_SELECT_CLASS,
} from "@/components/leads/QueueFilterBar";
import { QueueCsvButton } from "@/components/leads/QueueCsvButton";
import { type TeamPerson } from "@/components/leads/TeamMemberFilter";
import { MEMBER_ME, MEMBER_TEAM } from "@/lib/users/teamRules";
import { DATE_MODES, type DateMode } from "@/lib/asm/dateMode";
import type { QueueSortKey } from "@/lib/leads/queueSort";
import { VisitsStrip } from "./VisitsStrip";
import { BulkClaimBar } from "@/components/leads/BulkClaimBar";
import { ClaimLeadConfirm } from "@/components/leads/ClaimLeadConfirm";
import { ClaimByNumberPanel } from "@/components/leads/ClaimByNumberPanel";
import { ASM_POOL_TABS, claimsByNumberOnly } from "@/lib/leads/claimScope";
import { CLAIM_ROLES } from "@/lib/inside-sales/types";
import {
    EMPTY_QUEUE_FILTERS,
    hasAnyQueueFilter,
    readQueueFilters,
    writeQueueFilters,
    type QueueFilters,
    type QueueRegion,
} from "@/lib/leads/queueFilters";
import {
    EMPTY_QUEUE_SORT,
    readQueueSort,
    writeQueueSort,
    type QueueSort,
} from "@/lib/leads/queueSort";
import { AsmQueueTabs } from "./AsmQueueTabs";
import { AsmQueueTable } from "./AsmQueueTable";
import {
    ASM_QUEUE_TABS,
    VISIT_OUTCOME,
    VISIT_OUTCOME_LABELS,
    VISIT_STATUS,
    type AsmQueueCounts,
    type AsmQueueResponse,
    type AsmQueueRow,
    type AsmQueueTab,
    type VisitOutcome,
} from "@/lib/asm/types";

type Props = {
    viewerId: string;
    viewerRole: string;
    /** ID 199: the viewer's direct reports — non-empty shows the Team member pick. */
    teamPeople?: TeamPerson[];
    /** ID 244: the viewer's name, for "Every number on this page is for Me (Sonu)". */
    viewerName?: string | null;
};

const PAGE_SIZE = 25;

function parseTab(raw: string | null): AsmQueueTab {
    if (raw && (ASM_QUEUE_TABS as readonly string[]).includes(raw)) return raw as AsmQueueTab;
    return "my_visits";
}

/** `pending_scheduling` → `Pending Scheduling`. */
function pretty(v: string): string {
    return v.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AsmQueueView({ viewerId, viewerRole, teamPeople = [], viewerName = null }: Props) {
    const router = useRouter();
    const params = useSearchParams();
    const queryClient = useQueryClient();
    // B3: the claim routes gate on CLAIM_ROLES; a ceo / sales_head browsing
    // this queue sees the pool but gets no Claim controls rather than a 403.
    const canClaim = (CLAIM_ROLES as readonly string[]).includes(viewerRole);
    // ID 45: an ASM never lists the unowned pool (Territory Feed / Unclaimed) —
    // they claim by number search. Managers keep the territory view.
    const numberOnly = claimsByNumberOnly(viewerRole);
    const [tab, setTab] = useState<AsmQueueTab>(() => {
        const t = parseTab(params.get("tab"));
        return numberOnly && ASM_POOL_TABS.includes(t) ? "my_visits" : t;
    });
    const [page, setPage] = useState(Math.max(1, Number(params.get("page") ?? "1")));
    const [search, setSearch] = useState(params.get("q") ?? "");
    const [searchDebounced, setSearchDebounced] = useState(params.get("q") ?? "");
    const [createOpen, setCreateOpen] = useState(false);
    // Seeded from the URL so a filtered view survives a reload and can be
    // pasted to a colleague — the same contract the tab and page already had.
    const [filters, setFilters] = useState<QueueFilters>(() =>
        readQueueFilters(new URLSearchParams(params.toString())),
    );
    // Order, seeded from the URL like the filters so a sorted view survives a
    // reload and can be pasted to a colleague.
    const [sort, setSort] = useState<QueueSort>(() =>
        readQueueSort(new URLSearchParams(params.toString())),
    );
    const [visitStatus, setVisitStatus] = useState(() => {
        const v = params.get("visit_status") ?? "";
        return (VISIT_STATUS as readonly string[]).includes(v) ? v : "";
    });
    const [visitOutcome, setVisitOutcome] = useState(() => {
        const v = params.get("visit_outcome") ?? "";
        return (VISIT_OUTCOME as readonly string[]).includes(v) ? v : "";
    });
    // ID 75.4: the ASM's own "Finalised, not Won" list — the dealer approved
    // the quote and nobody pressed Mark Won. A chip, not a sixth tab.
    const [finalisedOnly, setFinalisedOnly] = useState(params.get("finalised") === "1");
    // 18 Oct row 34: only leads past a time limit.
    const [pastLimitOnly, setPastLimitOnly] = useState(params.get("past_limit") === "1");
    // ID 199: a manager's Team member pick ("" = whole team, "me", or an id).
    // Seeded from the URL so the My team email's links open it filtered.
    // ID 244 (Kartik, 11 Nov): a manager opens on Me. The whole team is written into the
    // link as "team", so a reload or a pasted link keeps it.
    const [member, setMember] = useState(params.get("member") ?? (teamPeople.length > 0 ? MEMBER_ME : ""));
    // ID 236: what the date range means — Booked (default) or Visited.
    const [dateMode, setDateMode] = useState<DateMode>(() => {
        const v = params.get("date_mode") ?? "";
        return (DATE_MODES as readonly string[]).includes(v) ? (v as DateMode) : "booked";
    });
    // ID 244: "Claim by number" is a button, the number search opens below it.
    const [claimOpen, setClaimOpen] = useState(false);
    // Open on load when ANY filter arrived in the URL, so a filter inherited
    // from a pasted link is never doing invisible work. Derived from the parsed
    // values rather than from param names, so it cannot fall out of step with
    // the filter set.
    const [filtersOpen, setFiltersOpen] = useState(
        () =>
            hasAnyQueueFilter(readQueueFilters(new URLSearchParams(params.toString()))) ||
            params.get("visit_status") !== null ||
            params.get("visit_outcome") !== null,
    );

    const extraActive = (visitStatus ? 1 : 0) + (visitOutcome ? 1 : 0);

    /**
     * Everything that narrows the list, as query params.
     *
     * ONE BUILDER for the rows request, the badge counts and the CSV href, so
     * the sheet is exactly what the screen is showing. `page` is deliberately
     * absent — the counts and the export both span the whole result set.
     */
    const filterParams = useMemo(() => {
        const p = new URLSearchParams();
        if (searchDebounced) p.set("q", searchDebounced);
        if (visitStatus) p.set("visit_status", visitStatus);
        if (visitOutcome) p.set("visit_outcome", visitOutcome);
        if (finalisedOnly) p.set("finalised", "1");
        if (pastLimitOnly) p.set("past_limit", "1");
        if (member) p.set("member", member);
        if (filters.from || filters.to) p.set("date_mode", dateMode);
        // The sort rides along: the rows and the CSV honour it, the counts and
        // facets simply never read it.
        writeQueueSort(p, sort);
        return writeQueueFilters(p, filters);
    }, [searchDebounced, visitStatus, visitOutcome, finalisedOnly, pastLimitOnly, member, filters, sort, dateMode]);

    const filterKey = filterParams.toString();

    useEffect(() => {
        const next = new URLSearchParams(filterKey);
        if (tab !== "my_visits") next.set("tab", tab);
        if (page !== 1) next.set("page", String(page));
        const qs = next.toString();
        router.replace(`/asm${qs ? `?${qs}` : ""}`, { scroll: false });
    }, [tab, page, filterKey, router]);

    useEffect(() => {
        const t = window.setTimeout(() => {
            setSearchDebounced(search);
            setPage(1);
        }, 300);
        return () => window.clearTimeout(t);
    }, [search]);

    const patchFilter = useCallback((key: keyof QueueFilters, value: string) => {
        setFilters((f) => ({ ...f, [key]: value }));
        setPage(1);
    }, []);

    // ID 243 / 244: a header click — ascending, then descending, then the default order.
    const toggleSort = useCallback((key: QueueSortKey) => {
        setSort((cur) => (cur.sort !== key ? { sort: key, dir: "asc" } : cur.dir === "asc" ? { sort: key, dir: "desc" } : { sort: "", dir: "asc" }));
        setPage(1);
    }, []);

    const resetFilters = useCallback(() => {
        setFilters(EMPTY_QUEUE_FILTERS);
        setSort(EMPTY_QUEUE_SORT);
        setVisitStatus("");
        setVisitOutcome("");
        setPage(1);
    }, []);

    const countsQuery = useQuery<{ success: true; data: AsmQueueCounts }>({
        // The filters are part of the key: the badges narrow with the list, so a
        // cached unfiltered count must not be shown above a filtered table.
        queryKey: ["asm-counts", filterKey],
        queryFn: async () => {
            const u = new URL("/api/asm/queue/counts", window.location.origin);
            u.search = filterKey;
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load tab counts");
            return res.json();
        },
        refetchInterval: 30000,
    });
    const counts = countsQuery.data?.data;

    // The State/City options this tab's leads actually span. Keyed on the tab
    // alone and cached for the session: the options describe the queue, not the
    // current filter, so re-fetching them as the filter changes would cost a
    // DISTINCT scan per keystroke to return the same list.
    const regionsQuery = useQuery<{ success: true; data: { regions: QueueRegion[] } }>({
        queryKey: ["asm-queue-regions", tab],
        queryFn: async () => {
            const u = new URL("/api/asm/queue/facets", window.location.origin);
            u.searchParams.set("tab", tab);
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load regions");
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
    });
    const regions = regionsQuery.data?.data?.regions ?? [];

    const rowsQuery = useQuery<{ success: true; data: AsmQueueResponse }>({
        queryKey: ["asm-queue", tab, page, filterKey],
        queryFn: async () => {
            const u = new URL("/api/asm/queue", window.location.origin);
            u.search = filterKey;
            u.searchParams.set("tab", tab);
            u.searchParams.set("page", String(page));
            u.searchParams.set("limit", String(PAGE_SIZE));
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load queue");
            return res.json();
        },
    });

    const data = rowsQuery.data?.data;

    // ── B3: claim from the territory pool ────────────────────────────────
    const refreshAfterClaim = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ["asm-queue"] });
        queryClient.invalidateQueries({ queryKey: ["asm-counts"] });
    }, [queryClient]);

    const [claimTarget, setClaimTarget] = useState<AsmQueueRow | null>(null);

    // Bulk selection on the two tabs that surface unowned leads: Unclaimed
    // (every row claimable) and Territory Feed (mixed — only the unowned rows
    // get a checkbox). Same reset-on-scope-change pattern as the Inside Sales
    // queue: a tab or filter change drops the selection, paging keeps it.
    const selectable = (tab === "unclaimed" || tab === "territory") && canClaim && !numberOnly;
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const selectionScope = `${tab}|${filterKey}`;
    const [selectionScopeSeen, setSelectionScopeSeen] = useState(selectionScope);
    if (selectionScopeSeen !== selectionScope) {
        setSelectionScopeSeen(selectionScope);
        setSelectedIds(new Set());
    }

    const toggleSelected = useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleAllOnPage = useCallback(() => {
        const pageRows = (data?.rows ?? []).filter((r) => !r.current_owner_id);
        setSelectedIds((prev) => {
            const next = new Set(prev);
            const allTicked = pageRows.length > 0 && pageRows.every((r) => next.has(r.id));
            if (allTicked) pageRows.forEach((r) => next.delete(r.id));
            else pageRows.forEach((r) => next.add(r.id));
            return next;
        });
    }, [data]);

    const [selectingFirstN, setSelectingFirstN] = useState(false);
    const selectFirstN = useCallback(
        async (n: number) => {
            setSelectingFirstN(true);
            try {
                const u = new URL("/api/asm/queue", window.location.origin);
                u.search = filterKey;
                u.searchParams.set("tab", tab);
                u.searchParams.set("ids_only", "1");
                u.searchParams.set("limit", String(n));
                const res = await fetch(u.toString(), { cache: "no-store" });
                const json = await res.json();
                if (!res.ok) throw new Error(json?.error?.message ?? "Failed to select leads");
                const ids: string[] = json.data?.ids ?? [];
                setSelectedIds(new Set(ids));
                setPage(1);
                toast.success(`Selected the first ${ids.length} lead${ids.length === 1 ? "" : "s"}`);
            } catch (err) {
                toast.error((err as Error).message);
            } finally {
                setSelectingFirstN(false);
            }
        },
        [filterKey, tab],
    );

    const onBulkClaimed = useCallback(() => {
        setSelectedIds(new Set());
        refreshAfterClaim();
    }, [refreshAfterClaim]);

    const showingWho = useMemo(() => {
        const me = viewerName ? `Me (${viewerName})` : "Me";
        if (teamPeople.length === 0 || member === MEMBER_ME) return me;
        if (!member || member === MEMBER_TEAM) {
            return `my whole team (${[viewerName ?? "me", ...teamPeople.map((t) => t.name)].join(", ")})`;
        }
        return teamPeople.find((t) => t.id === member)?.name ?? "this team member";
    }, [teamPeople, member, viewerName]);

    const exportHref = useMemo(() => {
        const p = new URLSearchParams(filterKey);
        p.set("tab", tab);
        return `/api/asm/queue/export?${p.toString()}`;
    }, [filterKey, tab]);

    return (
        <div className="space-y-4">
        {teamPeople.length > 0 && (
            <div className="flex justify-end">
                <label className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm">
                    <span className="font-medium text-gray-700">Showing</span>
                    <select
                        value={member || MEMBER_TEAM}
                        onChange={(e) => {
                            setMember(e.target.value);
                            setPage(1);
                        }}
                        className="h-9 min-w-[12rem] rounded-md border border-emerald-200 bg-emerald-50 px-2 text-sm font-medium text-emerald-800"
                        aria-label="Whose leads and numbers to show"
                    >
                        <option value={MEMBER_ME}>{viewerName ? `Me (${viewerName})` : "Me"}</option>
                        <option value={MEMBER_TEAM}>My whole team</option>
                        {teamPeople.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
        )}
        <VisitsStrip strip={counts?.strip} who={showingWho} loading={countsQuery.isLoading} />
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
            <AsmQueueTabs
                active={tab}
                counts={counts ?? null}
                hidden={numberOnly ? ASM_POOL_TABS : []}
                onChange={(t) => {
                    setTab(t);
                    setPage(1);
                }}
            />
            <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-4 py-3">
                <div className="relative min-w-[220px] flex-1 md:max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search dealer, shop or phone…"
                        className="pl-9"
                    />
                </div>
                {/* ID 75.4 — beside the search box, not behind the filter
                    disclosure: an ACTION list (go mark these Won). The badge
                    counts the ASM's own My visits leads waiting for Mark Won. */}
                <button
                    type="button"
                    onClick={() => {
                        setFinalisedOnly((v) => !v);
                        setPage(1);
                    }}
                    aria-pressed={finalisedOnly}
                    title={
                        finalisedOnly
                            ? "Showing only leads the dealer approved that are not marked Won yet — click to show all"
                            : "Show only leads the dealer approved that are not marked Won yet"
                    }
                    className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 ${
                        finalisedOnly
                            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                            : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                >
                    <span
                        aria-hidden
                        className={`h-1.5 w-1.5 rounded-full ${
                            finalisedOnly ? "bg-emerald-500" : "bg-gray-300"
                        }`}
                    />
                    Dealer agreed, not Won
                    {counts?.finalised_not_won ? (
                        <span className="ml-0.5 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                            {counts.finalised_not_won}
                        </span>
                    ) : null}
                </button>
                {/* 18 Oct row 34 — "Past a limit" as a filter: leads with a time
                    limit still running past due (the chip on the row names which). */}
                <button
                    type="button"
                    onClick={() => {
                        setPastLimitOnly((v) => !v);
                        setPage(1);
                    }}
                    aria-pressed={pastLimitOnly}
                    title={
                        pastLimitOnly
                            ? "Showing only leads past a time limit — click to show all"
                            : "Show only leads past a time limit (Admin › Time limits)"
                    }
                    className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-rose-500 ${
                        pastLimitOnly
                            ? "border-rose-300 bg-rose-50 text-rose-700"
                            : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                >
                    <span
                        aria-hidden
                        className={`h-1.5 w-1.5 rounded-full ${pastLimitOnly ? "bg-rose-500" : "bg-gray-300"}`}
                    />
                    Past a limit
                    {counts?.past_limit ? (
                        <span className="ml-0.5 rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                            {counts.past_limit}
                        </span>
                    ) : null}
                </button>
                <QueueFilterBar
                    values={filters}
                    onChange={patchFilter}
                    onReset={resetFilters}
                    open={filtersOpen}
                    onToggle={() => setFiltersOpen((v) => !v)}
                    regions={regions}
                    // Not "created": an ASM's range question is which visits fall
                    // in the window, and the queue filters on the visit date.
                    dateLabel="Visit"
                    extraActiveCount={extraActive}
                >
                    <QueueFilterField label="Dates mean">
                        <select
                            value={dateMode}
                            onChange={(e) => {
                                setDateMode(e.target.value as DateMode);
                                setPage(1);
                            }}
                            className={QUEUE_SELECT_CLASS}
                            aria-describedby="date-mode-hint"
                        >
                            <option value="booked">Booked (visits planned in the range)</option>
                            <option value="visited">Visited (visits done in the range)</option>
                        </select>
                        <p id="date-mode-hint" className="mt-1 text-[11px] text-gray-500">
                            Cancelled and no-show visits never count.
                        </p>
                    </QueueFilterField>
                    <QueueFilterField label="Visit status">
                        <select
                            value={visitStatus}
                            onChange={(e) => {
                                setVisitStatus(e.target.value);
                                setPage(1);
                            }}
                            className={QUEUE_SELECT_CLASS}
                        >
                            <option value="">Any visit status</option>
                            {VISIT_STATUS.map((v) => (
                                <option key={v} value={v}>
                                    {pretty(v)}
                                </option>
                            ))}
                        </select>
                    </QueueFilterField>
                    <QueueFilterField label="Visit outcome">
                        <select
                            value={visitOutcome}
                            onChange={(e) => {
                                setVisitOutcome(e.target.value);
                                setPage(1);
                            }}
                            className={QUEUE_SELECT_CLASS}
                        >
                            <option value="">Any outcome</option>
                            {VISIT_OUTCOME.map((v) => (
                                <option key={v} value={v}>
                                    {VISIT_OUTCOME_LABELS[v as VisitOutcome]}
                                </option>
                            ))}
                        </select>
                    </QueueFilterField>
                </QueueFilterBar>
                {rowsQuery.isFetching && (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                )}
                <div className="ml-auto flex items-center gap-2">
                    {numberOnly && (
                        <Button type="button" variant="outline" onClick={() => setClaimOpen((v) => !v)} aria-expanded={claimOpen}>
                            Claim by number
                        </Button>
                    )}
                    <QueueCsvButton
                        href={exportHref}
                        filename={`asm-${tab}`}
                        disabled={rowsQuery.isLoading}
                    />
                    <Button type="button" onClick={() => setCreateOpen(true)} className="gap-1.5">
                        <Plus className="h-4 w-4" />
                        Create lead
                    </Button>
                </div>
            </div>
            {numberOnly && claimOpen && (
                <div className="border-b border-gray-100 p-4">
                    <ClaimByNumberPanel onClaimed={() => void queryClient.invalidateQueries()} />
                </div>
            )}
            <AsmQueueTable
                tab={tab}
                sort={sort}
                onSort={toggleSort}
                // ID 199: the review columns on a manager's team view.
                showReview={teamPeople.length > 0 && member !== MEMBER_ME}
                rows={data?.rows ?? []}
                total={data?.total ?? 0}
                page={page}
                pageSize={PAGE_SIZE}
                loading={rowsQuery.isLoading}
                error={rowsQuery.error ? (rowsQuery.error as Error).message : null}
                onPageChange={setPage}
                viewerId={viewerId}
                onClaim={canClaim ? setClaimTarget : undefined}
                selection={
                    selectable
                        ? {
                              selected: selectedIds,
                              onToggle: toggleSelected,
                              onToggleAll: toggleAllOnPage,
                          }
                        : undefined
                }
            />
            {selectable && (
                <BulkClaimBar
                    selectedIds={Array.from(selectedIds)}
                    total={data?.total ?? 0}
                    selectFirstN={selectFirstN}
                    selectingFirstN={selectingFirstN}
                    onClear={() => setSelectedIds(new Set())}
                    onClaimed={onBulkClaimed}
                />
            )}
            {claimTarget && (
                <ClaimLeadConfirm
                    open
                    onClose={() => setClaimTarget(null)}
                    leadId={claimTarget.id}
                    dealerName={claimTarget.dealer_name || claimTarget.shop_name || "this lead"}
                    onSuccess={() => {
                        setClaimTarget(null);
                        refreshAfterClaim();
                    }}
                />
            )}
            <CreateLeadModal
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                onSuccess={() => {
                    setCreateOpen(false);
                    queryClient.invalidateQueries({ queryKey: ["asm-queue"] });
                    queryClient.invalidateQueries({ queryKey: ["asm-counts"] });
                }}
            />
        </div>
        </div>
    );
}
