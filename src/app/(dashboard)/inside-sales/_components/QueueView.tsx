"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Search, Loader2, Plus, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { QueueTabs } from "./QueueTabs";
import { LeadQueueTable } from "./LeadQueueTable";
import { CreateLeadModal } from "./modals/CreateLeadModal";
import {
    QUEUE_TABS,
    type QueueCounts,
    type QueueResponse,
    type QueueTab,
} from "@/lib/inside-sales/types";

type Props = {
    viewerId: string;
    viewerRole: string;
};

// Roles allowed to bulk-upload leads — must match the upload page + API gate.
const UPLOAD_ROLES = ["inside_sales_rep", "admin", "sales_head", "sales_insight"];

function parseTab(raw: string | null): QueueTab {
    if (raw && (QUEUE_TABS as readonly string[]).includes(raw)) return raw as QueueTab;
    return "my_open";
}

const PAGE_SIZE = 25;

export function QueueView({ viewerId, viewerRole }: Props) {
    const canUpload = UPLOAD_ROLES.includes(viewerRole);
    const router = useRouter();
    const queryClient = useQueryClient();
    const params = useSearchParams();
    const initialTab = parseTab(params.get("tab"));
    const initialPage = Math.max(1, Number(params.get("page") ?? "1"));
    const initialQ = params.get("q") ?? "";

    const [tab, setTab] = useState<QueueTab>(initialTab);
    const [page, setPage] = useState(initialPage);
    const [search, setSearch] = useState(initialQ);
    const [searchDebounced, setSearchDebounced] = useState(initialQ);
    const [createOpen, setCreateOpen] = useState(false);

    // Sync state → URL for back/forward + share.
    useEffect(() => {
        const next = new URLSearchParams();
        if (tab !== "my_open") next.set("tab", tab);
        if (page !== 1) next.set("page", String(page));
        if (searchDebounced) next.set("q", searchDebounced);
        const queryString = next.toString();
        router.replace(`/inside-sales${queryString ? `?${queryString}` : ""}`, { scroll: false });
    }, [tab, page, searchDebounced, router]);

    // 300ms debounce on the search box.
    useEffect(() => {
        const t = window.setTimeout(() => {
            setSearchDebounced(search);
            setPage(1);
        }, 300);
        return () => window.clearTimeout(t);
    }, [search]);

    // ── Counts (all tabs) ────────────────────────────────────────────────
    const countsQuery = useQuery<{ success: true; data: QueueCounts }>({
        queryKey: ["inside-sales-counts"],
        queryFn: async () => {
            const res = await fetch("/api/inside-sales/queue/counts", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load tab counts");
            return res.json();
        },
        refetchInterval: 30000, // 30s — keeps badges fresh without being noisy
    });
    const counts = countsQuery.data?.data;

    // ── Rows (current tab) ───────────────────────────────────────────────
    const rowsQuery = useQuery<{ success: true; data: QueueResponse }>({
        queryKey: ["inside-sales-queue", tab, page, searchDebounced],
        queryFn: async () => {
            const u = new URL("/api/inside-sales/queue", window.location.origin);
            u.searchParams.set("tab", tab);
            u.searchParams.set("page", String(page));
            u.searchParams.set("limit", String(PAGE_SIZE));
            if (searchDebounced) u.searchParams.set("q", searchDebounced);
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load queue");
            return res.json();
        },
    });

    const data = rowsQuery.data?.data;

    // ── Holiday cache for stale-row visual cues (BRD §0.5) ───────────────
    const holidaysQuery = useQuery<{ success: true; data: { dates: string[] } }>({
        queryKey: ["inside-sales-holidays"],
        queryFn: async () => {
            const res = await fetch("/api/inside-sales/holidays", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load holiday calendar");
            return res.json();
        },
        staleTime: 60 * 60 * 1000, // 1h
    });
    const holidaySet = useMemo(
        () => new Set(holidaysQuery.data?.data?.dates ?? []),
        [holidaysQuery.data],
    );

    return (
        <div className="space-y-4">
            <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
                <QueueTabs
                    active={tab}
                    counts={counts ?? null}
                    onChange={(t) => {
                        setTab(t);
                        setPage(1);
                    }}
                />
                <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search by dealer, shop, or phone…"
                            className="pl-9"
                        />
                    </div>
                    {rowsQuery.isFetching && (
                        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        {canUpload && (
                            <Link
                                href="/inside-sales/upload"
                                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                            >
                                <Upload className="h-4 w-4" />
                                Upload Leads
                            </Link>
                        )}
                        <Button type="button" onClick={() => setCreateOpen(true)} className="gap-1.5">
                            <Plus className="h-4 w-4" />
                            Create Lead
                        </Button>
                    </div>
                </div>
                <LeadQueueTable
                    tab={tab}
                    rows={data?.rows ?? []}
                    total={data?.total ?? 0}
                    page={page}
                    pageSize={PAGE_SIZE}
                    loading={rowsQuery.isLoading}
                    error={rowsQuery.error ? (rowsQuery.error as Error).message : null}
                    onPageChange={setPage}
                    viewerId={viewerId}
                    holidaySet={holidaySet}
                />
            </div>
            <CreateLeadModal
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                onSuccess={() => {
                    setCreateOpen(false);
                    queryClient.invalidateQueries({ queryKey: ["inside-sales-queue"] });
                    queryClient.invalidateQueries({ queryKey: ["inside-sales-counts"] });
                    setTab("unassigned");
                    setPage(1);
                }}
            />
        </div>
    );
}
