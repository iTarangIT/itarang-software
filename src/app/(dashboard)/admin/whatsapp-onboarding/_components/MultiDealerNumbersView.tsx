"use client";

// E-279 — "Multiple dealer" tab: extra WhatsApp numbers that act as the MAIN
// dealer for one dealership. Mirrors WhatsAppOperatorsView; CRUD backed by
// /api/admin/dealer-extra-numbers.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddExtraNumberModal } from "./AddExtraNumberModal";
import { ExtraNumberTable } from "./ExtraNumberTable";

const WRITE_ROLES = new Set(["admin", "sales_head"]);

export interface ExtraNumberRow {
    id: string;
    dealerCode: string;
    dealerName: string | null;
    waPhone: string;
    displayName: string;
    isActive: boolean;
    notes: string | null;
    createdAt: string;
    deactivatedAt: string | null;
}

export interface DealerOption {
    id: string;
    business_entity_name: string | null;
    dealer_code: string | null;
    city: string | null;
    has_login: boolean;
}

export function MultiDealerNumbersView({ viewerRole }: { viewerRole: string }) {
    const qc = useQueryClient();
    const canWrite = WRITE_ROLES.has(viewerRole);

    const [dealerCode, setDealerCode] = useState<string>("");
    const [addOpen, setAddOpen] = useState(false);

    // The dealer picker rides /api/admin/dealers, which is gated on the
    // inventory-admin roles (no ceo) — so only fetch it for writers. The ceo
    // still sees every number: the list endpoint carries dealer names itself.
    const dealersQuery = useQuery<{ success: true; data: DealerOption[] }>({
        queryKey: ["admin-dealers-for-extra-numbers"],
        queryFn: async () => {
            const res = await fetch("/api/admin/dealers?limit=500", {
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Failed to load dealers");
            return res.json();
        },
        enabled: canWrite,
        staleTime: 5 * 60_000,
    });
    const dealers = dealersQuery.data?.data ?? [];

    const query = useQuery<{
        success: true;
        data: { numbers: ExtraNumberRow[] };
    }>({
        queryKey: ["admin-dealer-extra-numbers", dealerCode],
        queryFn: async () => {
            const qs = dealerCode
                ? `?dealerCode=${encodeURIComponent(dealerCode)}`
                : "";
            const res = await fetch(`/api/admin/dealer-extra-numbers${qs}`, {
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Failed to load dealer numbers");
            return res.json();
        },
        refetchInterval: 60_000,
    });
    const numbers = query.data?.data.numbers ?? [];

    const refresh = () => {
        qc.invalidateQueries({ queryKey: ["admin-dealer-extra-numbers"] });
    };

    return (
        <div className="space-y-5">
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
                    <h2 className="text-sm font-semibold text-ink">
                        Multiple dealer numbers
                    </h2>
                    {query.isFetching && (
                        <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        {canWrite && (
                            <select
                                value={dealerCode}
                                onChange={(e) => setDealerCode(e.target.value)}
                                className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink"
                            >
                                <option value="">All dealers</option>
                                {dealers.map((d) => (
                                    <option key={d.id} value={d.id}>
                                        {d.business_entity_name || d.id}
                                        {d.city ? ` · ${d.city}` : ""}
                                    </option>
                                ))}
                            </select>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={refresh}
                            title="Refresh"
                        >
                            <RefreshCw className="h-4 w-4" />
                        </Button>
                        {canWrite && (
                            <Button size="sm" onClick={() => setAddOpen(true)}>
                                <Plus className="h-4 w-4 mr-1.5" />
                                Add number
                            </Button>
                        )}
                    </div>
                </div>

                <div className="px-4 py-2 border-b border-border text-xs text-ink-muted">
                    Every number here opens the FULL dealer console on WhatsApp
                    for its dealership — customer leads created from it belong
                    to that dealer, exactly like the dealer&apos;s own number.
                    For restricted, own-leads-only numbers use the dealer&apos;s
                    sales team instead.
                </div>

                {query.isError ? (
                    <div className="px-4 py-8 text-sm text-danger">
                        Couldn&apos;t load the dealer numbers.
                    </div>
                ) : (
                    <ExtraNumberTable
                        numbers={numbers}
                        loading={query.isLoading}
                        canWrite={canWrite}
                        onChanged={refresh}
                    />
                )}
            </div>

            {addOpen && (
                <AddExtraNumberModal
                    dealers={dealers}
                    initialDealerCode={dealerCode}
                    onClose={() => setAddOpen(false)}
                    onAdded={() => {
                        setAddOpen(false);
                        refresh();
                    }}
                />
            )}
        </div>
    );
}
