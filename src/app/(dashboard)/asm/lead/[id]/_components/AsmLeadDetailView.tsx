"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { LeadDetailBundle } from "@/lib/inside-sales/types";
import { LeadDetailHeader } from "@/app/(dashboard)/inside-sales/lead/[id]/_components/LeadDetailHeader";
import { TouchpointHistoryPane } from "@/app/(dashboard)/inside-sales/lead/[id]/_components/TouchpointHistoryPane";
import { LeadDetailRightPane } from "@/app/(dashboard)/inside-sales/lead/[id]/_components/LeadDetailRightPane";
import { ConcurrencyBanner } from "@/app/(dashboard)/inside-sales/_components/ConcurrencyBanner";
import { LogTouchpointModal } from "@/app/(dashboard)/inside-sales/_components/modals/LogTouchpointModal";
import { UpdateCommercialsModal } from "@/app/(dashboard)/inside-sales/_components/modals/UpdateCommercialsModal";
import { MarkLostModal } from "@/app/(dashboard)/inside-sales/_components/modals/MarkLostModal";
import { MarkConvertedModal } from "@/app/(dashboard)/inside-sales/_components/modals/MarkConvertedModal";
import { ReassignLeadModal } from "@/app/(dashboard)/inside-sales/_components/modals/ReassignLeadModal";
import { EscalateModal } from "@/app/(dashboard)/inside-sales/_components/modals/EscalateModal";
import { LogVisitModal } from "@/app/(dashboard)/asm/_components/modals/LogVisitModal";
import { AsmLeadActionBar } from "./AsmLeadActionBar";
import type { VisitNextAction } from "@/lib/asm/types";

type ActiveModal =
    | null
    | "visit"
    | "touchpoint"
    | "commercials"
    | "mark_lost"
    | "mark_converted"
    | "reassign"
    | "escalate";

type Props = {
    leadId: string;
    viewerId: string;
    viewerRole: string;
};

export function AsmLeadDetailView({ leadId, viewerId, viewerRole }: Props) {
    const qc = useQueryClient();
    const [activeModal, setActiveModal] = useState<ActiveModal>(null);
    const [staleInfo, setStaleInfo] = useState<{
        currentOwnerName?: string | null;
        currentUpdatedAt?: string | null;
    } | null>(null);

    const query = useQuery<{ success: true; data: LeadDetailBundle }>({
        queryKey: ["asm-lead", leadId],
        queryFn: async () => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}`, { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load lead");
            return res.json();
        },
        refetchOnWindowFocus: true,
    });

    const invalidate = useCallback(() => {
        qc.invalidateQueries({ queryKey: ["asm-lead", leadId] });
        qc.invalidateQueries({ queryKey: ["asm-queue"] });
        qc.invalidateQueries({ queryKey: ["asm-counts"] });
        // Keep the IS rep queue / lead in sync too — they share state.
        qc.invalidateQueries({ queryKey: ["inside-sales-queue"] });
        qc.invalidateQueries({ queryKey: ["inside-sales-counts"] });
        qc.invalidateQueries({ queryKey: ["inside-sales-lead", leadId] });
    }, [qc, leadId]);

    const onActionSuccess = useCallback(() => {
        setActiveModal(null);
        setStaleInfo(null);
        invalidate();
    }, [invalidate]);

    // Visit save chains into the lifecycle modal per BRD §0.8.
    const onVisitSuccess = useCallback(
        ({ next_action }: { next_action: VisitNextAction }) => {
            setActiveModal(null);
            invalidate();
            if (next_action === "convert") setActiveModal("mark_converted");
            else if (next_action === "lost") setActiveModal("mark_lost");
            else if (next_action === "escalate") setActiveModal("escalate");
        },
        [invalidate],
    );

    const onStaleConflict = useCallback(
        (info: { currentOwnerName?: string | null; currentUpdatedAt?: string | null }) => {
            setStaleInfo(info);
        },
        [],
    );

    if (query.isLoading) {
        return (
            <div className="px-6 py-10 flex items-center justify-center text-gray-500">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading lead…
            </div>
        );
    }
    if (query.error || !query.data?.data) {
        return (
            <div className="px-6 py-10 max-w-2xl">
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-rose-600 shrink-0" />
                    <div className="text-sm text-rose-800">
                        {(query.error as Error | undefined)?.message ?? "Lead not found or no longer accessible."}
                    </div>
                </div>
                <Link href="/asm" className="mt-4 inline-flex items-center gap-1 text-sm text-emerald-700 hover:underline">
                    <ArrowLeft className="h-4 w-4" />
                    Back to queue
                </Link>
            </div>
        );
    }

    const bundle = query.data.data;
    const lead = bundle.lead;
    const isOwner = lead.current_owner_id === viewerId;
    const updatedAt = lead.updated_at;

    return (
        <div className="flex flex-col h-[calc(100vh-68px)]">
            <LeadDetailHeader bundle={bundle} viewerId={viewerId} />

            {staleInfo && (
                <div className="px-6 pt-3">
                    <ConcurrencyBanner
                        onRefresh={() => {
                            setStaleInfo(null);
                            invalidate();
                        }}
                        currentOwnerName={staleInfo.currentOwnerName ?? lead.current_owner_name}
                        currentUpdatedAt={staleInfo.currentUpdatedAt ?? updatedAt}
                    />
                </div>
            )}

            <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-0">
                <TouchpointHistoryPane touchpoints={bundle.touchpoints} statusHistory={bundle.status_history} />
                <LeadDetailRightPane bundle={bundle} />
            </div>

            <AsmLeadActionBar
                bundle={bundle}
                isOwner={isOwner}
                viewerRole={viewerRole}
                onAction={setActiveModal}
            />

            <LogVisitModal
                open={activeModal === "visit"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                onSuccess={onVisitSuccess}
            />
            <LogTouchpointModal
                open={activeModal === "touchpoint"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                lead={lead}
                onSuccess={onActionSuccess}
                onStaleConflict={onStaleConflict}
                updatedAt={updatedAt}
                context="asm"
                onVisitSuccess={onVisitSuccess}
            />
            <UpdateCommercialsModal
                open={activeModal === "commercials"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                currentCommercials={bundle.current_commercials}
                onSuccess={onActionSuccess}
            />
            <MarkLostModal
                open={activeModal === "mark_lost"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                onSuccess={onActionSuccess}
            />
            <MarkConvertedModal
                open={activeModal === "mark_converted"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                onSuccess={onActionSuccess}
            />
            <ReassignLeadModal
                open={activeModal === "reassign"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                viewerId={viewerId}
                onSuccess={onActionSuccess}
            />
            <EscalateModal
                open={activeModal === "escalate"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                viewerRole={viewerRole}
                onSuccess={onActionSuccess}
            />
        </div>
    );
}
