"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Loader2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateLeadModal } from "@/app/(dashboard)/inside-sales/_components/modals/CreateLeadModal";
import { AsmQueueTabs } from "./AsmQueueTabs";
import { AsmQueueTable } from "./AsmQueueTable";
import {
    ASM_QUEUE_TABS,
    type AsmQueueCounts,
    type AsmQueueResponse,
    type AsmQueueTab,
} from "@/lib/asm/types";

type Props = {
    viewerId: string;
};

const PAGE_SIZE = 25;

function parseTab(raw: string | null): AsmQueueTab {
    if (raw && (ASM_QUEUE_TABS as readonly string[]).includes(raw)) return raw as AsmQueueTab;
    return "my_visits";
}

export function AsmQueueView({ viewerId }: Props) {
    const router = useRouter();
    const params = useSearchParams();
    const queryClient = useQueryClient();
    const [tab, setTab] = useState<AsmQueueTab>(parseTab(params.get("tab")));
    const [page, setPage] = useState(Math.max(1, Number(params.get("page") ?? "1")));
    const [search, setSearch] = useState(params.get("q") ?? "");
    const [searchDebounced, setSearchDebounced] = useState(params.get("q") ?? "");
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        const next = new URLSearchParams();
        if (tab !== "my_visits") next.set("tab", tab);
        if (page !== 1) next.set("page", String(page));
        if (searchDebounced) next.set("q", searchDebounced);
        const qs = next.toString();
        router.replace(`/asm${qs ? `?${qs}` : ""}`, { scroll: false });
    }, [tab, page, searchDebounced, router]);

    useEffect(() => {
        const t = window.setTimeout(() => {
            setSearchDebounced(search);
            setPage(1);
        }, 300);
        return () => window.clearTimeout(t);
    }, [search]);

    const countsQuery = useQuery<{ success: true; data: AsmQueueCounts }>({
        queryKey: ["asm-counts"],
        queryFn: async () => {
            const res = await fetch("/api/asm/queue/counts", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load tab counts");
            return res.json();
        },
        refetchInterval: 30000,
    });
    const counts = countsQuery.data?.data;

    const rowsQuery = useQuery<{ success: true; data: AsmQueueResponse }>({
        queryKey: ["asm-queue", tab, page, searchDebounced],
        queryFn: async () => {
            const u = new URL("/api/asm/queue", window.location.origin);
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

    return (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
            <AsmQueueTabs
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
                <div className="ml-auto">
                    <Button type="button" onClick={() => setCreateOpen(true)} className="gap-1.5">
                        <Plus className="h-4 w-4" />
                        Create Lead
                    </Button>
                </div>
            </div>
            <AsmQueueTable
                tab={tab}
                rows={data?.rows ?? []}
                total={data?.total ?? 0}
                page={page}
                pageSize={PAGE_SIZE}
                loading={rowsQuery.isLoading}
                error={rowsQuery.error ? (rowsQuery.error as Error).message : null}
                onPageChange={setPage}
                viewerId={viewerId}
            />
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
    );
}
