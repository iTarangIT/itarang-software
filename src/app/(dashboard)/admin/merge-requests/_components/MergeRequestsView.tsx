"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import type { MergeRequestRow } from "@/lib/admin/types";
import { MergeRequestTable } from "./MergeRequestTable";
import { ResolveMergeRequestModal } from "./ResolveMergeRequestModal";

type QueueResponse = {
    rows: MergeRequestRow[];
    total: number;
    page: number;
    limit: number;
    status: "pending" | "resolved";
};

const PAGE_SIZE = 25;

export function MergeRequestsView({ viewerRole }: { viewerRole: string }) {
    const qc = useQueryClient();
    const [tab, setTab] = useState<"pending" | "resolved">("pending");
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const [searchDebounced, setSearchDebounced] = useState("");
    const [active, setActive] = useState<MergeRequestRow | null>(null);

    useEffect(() => {
        const t = window.setTimeout(() => {
            setSearchDebounced(search);
            setPage(1);
        }, 300);
        return () => window.clearTimeout(t);
    }, [search]);

    const query = useQuery<{ success: true; data: QueueResponse }>({
        queryKey: ["admin-merge-requests", tab, page, searchDebounced],
        queryFn: async () => {
            const u = new URL(
                "/api/admin/merge-requests",
                window.location.origin,
            );
            u.searchParams.set("status", tab);
            u.searchParams.set("page", String(page));
            u.searchParams.set("limit", String(PAGE_SIZE));
            if (searchDebounced) u.searchParams.set("q", searchDebounced);
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load merge requests");
            return res.json();
        },
        refetchInterval: 60_000,
    });
    const data = query.data?.data;

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-2 pt-1">
                <Tabs
                    tabs={[
                        { value: "pending", label: "Pending" },
                        { value: "resolved", label: "Resolved" },
                    ]}
                    value={tab}
                    onValueChange={(v) => {
                        setTab(v as "pending" | "resolved");
                        setPage(1);
                    }}
                />
            </div>
            <div className="px-4 py-3 border-y border-border flex items-center gap-3">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by dealer or phone…"
                        className="pl-9"
                    />
                </div>
                {query.isFetching && (
                    <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
                )}
            </div>
            <MergeRequestTable
                rows={data?.rows ?? []}
                total={data?.total ?? 0}
                page={page}
                pageSize={PAGE_SIZE}
                loading={query.isLoading}
                error={query.error ? (query.error as Error).message : null}
                onPageChange={setPage}
                canResolve={(viewerRole === "admin" || viewerRole === "sales_head") && tab === "pending"}
                onResolve={setActive}
            />

            {active && (
                <ResolveMergeRequestModal
                    open={!!active}
                    request={active}
                    onClose={() => setActive(null)}
                    onSuccess={() => {
                        setActive(null);
                        qc.invalidateQueries({
                            queryKey: ["admin-merge-requests"],
                        });
                        qc.invalidateQueries({ queryKey: ["admin-dashboard"] });
                    }}
                />
            )}
        </div>
    );
}
