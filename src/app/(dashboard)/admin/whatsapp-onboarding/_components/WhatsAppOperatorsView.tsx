"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddOperatorModal } from "./AddOperatorModal";
import { OperatorTable } from "./OperatorTable";
import { OperatorPipelinePanel } from "./OperatorPipelinePanel";
import { TranscriptDrawer } from "./TranscriptDrawer";
import type { OperatorRow, TranscriptTarget } from "./types";

const WRITE_ROLES = new Set(["admin", "sales_head"]);

export function WhatsAppOperatorsView({ viewerRole }: { viewerRole: string }) {
    const qc = useQueryClient();
    const canWrite = WRITE_ROLES.has(viewerRole);

    const [addOpen, setAddOpen] = useState(false);
    const [selected, setSelected] = useState<OperatorRow | null>(null);
    const [transcript, setTranscript] = useState<TranscriptTarget | null>(null);

    const query = useQuery<{ success: true; data: { operators: OperatorRow[] } }>({
        queryKey: ["admin-whatsapp-operators"],
        queryFn: async () => {
            const res = await fetch("/api/admin/whatsapp-operators", {
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Failed to load onboarding operators");
            return res.json();
        },
        refetchInterval: 60_000,
    });

    const operators = query.data?.data.operators ?? [];

    const refresh = () => {
        qc.invalidateQueries({ queryKey: ["admin-whatsapp-operators"] });
        if (selected) {
            qc.invalidateQueries({
                queryKey: ["admin-whatsapp-operator-pipeline", selected.id],
            });
        }
    };

    return (
        <div className="space-y-5">
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="px-4 py-3 border-b border-border flex items-center gap-3">
                    <h2 className="text-sm font-semibold text-ink">
                        Onboarding team
                    </h2>
                    {query.isFetching && (
                        <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
                    )}
                    <div className="ml-auto flex items-center gap-2">
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

                {query.isError ? (
                    <div className="px-4 py-8 text-sm text-danger">
                        Couldn&apos;t load the onboarding team.
                    </div>
                ) : (
                    <OperatorTable
                        operators={operators}
                        loading={query.isLoading}
                        canWrite={canWrite}
                        selectedId={selected?.id ?? null}
                        onSelect={setSelected}
                        onChanged={refresh}
                    />
                )}
            </div>

            {selected && (
                <OperatorPipelinePanel
                    operator={selected}
                    canWrite={canWrite}
                    onClose={() => setSelected(null)}
                    onOpenTranscript={setTranscript}
                />
            )}

            {addOpen && (
                <AddOperatorModal
                    onClose={() => setAddOpen(false)}
                    onAdded={() => {
                        setAddOpen(false);
                        refresh();
                    }}
                />
            )}

            {transcript && (
                <TranscriptDrawer
                    target={transcript}
                    onClose={() => setTranscript(null)}
                />
            )}
        </div>
    );
}
