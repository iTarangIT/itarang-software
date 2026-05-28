"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { OnboardingDropoutRow } from "@/lib/admin/types";
import { OnboardingDropoutTable } from "./OnboardingDropoutTable";
import { ResolveDropoutModal } from "./ResolveDropoutModal";

type QueueResponse = {
    rows: OnboardingDropoutRow[];
    total: number;
    page: number;
    limit: number;
};

const PAGE_SIZE = 25;

export function OnboardingDropoutsView({
    viewerRole,
}: {
    viewerRole: string;
}) {
    const qc = useQueryClient();
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const [searchDebounced, setSearchDebounced] = useState("");
    const [active, setActive] = useState<OnboardingDropoutRow | null>(null);

    useEffect(() => {
        const t = window.setTimeout(() => {
            setSearchDebounced(search);
            setPage(1);
        }, 300);
        return () => window.clearTimeout(t);
    }, [search]);

    const query = useQuery<{ success: true; data: QueueResponse }>({
        queryKey: ["admin-onboarding-dropouts", page, searchDebounced],
        queryFn: async () => {
            const u = new URL(
                "/api/admin/onboarding-dropouts",
                window.location.origin,
            );
            u.searchParams.set("page", String(page));
            u.searchParams.set("limit", String(PAGE_SIZE));
            if (searchDebounced) u.searchParams.set("q", searchDebounced);
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load onboarding dropouts");
            return res.json();
        },
        refetchInterval: 60_000,
    });
    const data = query.data?.data;

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 py-3 border-b border-border flex items-center gap-3">
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
            <OnboardingDropoutTable
                rows={data?.rows ?? []}
                total={data?.total ?? 0}
                page={page}
                pageSize={PAGE_SIZE}
                loading={query.isLoading}
                error={query.error ? (query.error as Error).message : null}
                onPageChange={setPage}
                canResolve={(viewerRole === "admin" || viewerRole === "sales_head")}
                onResolve={setActive}
            />

            {active && (
                <ResolveDropoutModal
                    open={!!active}
                    dropout={active}
                    onClose={() => setActive(null)}
                    onSuccess={() => {
                        setActive(null);
                        qc.invalidateQueries({
                            queryKey: ["admin-onboarding-dropouts"],
                        });
                        qc.invalidateQueries({ queryKey: ["admin-dashboard"] });
                    }}
                />
            )}
        </div>
    );
}
