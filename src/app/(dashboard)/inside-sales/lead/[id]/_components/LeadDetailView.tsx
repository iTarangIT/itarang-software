"use client";

import type { LostReason } from "@/lib/lifecycle/transitions";
import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { hasApprovedQuote, type LeadDetailBundle } from "@/lib/inside-sales/types";
import { LeadDetailHeader } from "./LeadDetailHeader";
import { LeadActivityPanes } from "./LeadActivityPanes";
import { LeadDetailRightPane } from "./LeadDetailRightPane";
import { LeadActionBar } from "./LeadActionBar";
import { ConcurrencyBanner } from "../../../_components/ConcurrencyBanner";
import { LogTouchpointModal } from "../../../_components/modals/LogTouchpointModal";
import { UpdateCommercialsModal } from "../../../_components/modals/UpdateCommercialsModal";
import { TransferAsmModal } from "../../../_components/modals/TransferAsmModal";
import { MarkLostModal } from "../../../_components/modals/MarkLostModal";
import { MarkConvertedModal } from "../../../_components/modals/MarkConvertedModal";
import { ReassignLeadModal } from "../../../_components/modals/ReassignLeadModal";
import { EscalateModal } from "../../../_components/modals/EscalateModal";
import { ClaimLeadConfirm } from "../../../_components/modals/ClaimLeadConfirm";
import { canExportLeadHistory } from "@/lib/leads/access";

export type ActiveModal =
    | null
    | "touchpoint"
    | "commercials"
    | "transfer_asm"
    | "mark_lost"
    | "mark_converted"
    | "reassign"
    | "escalate"
    | "claim";

type Props = {
    leadId: string;
    viewerId: string;
    viewerRole: string;
    /** Where "Back to queue" goes. Twins of this view (/partner) pass their own. */
    backHref?: string;
};

export function LeadDetailView({ leadId, viewerId, viewerRole, backHref = "/inside-sales" }: Props) {
    const qc = useQueryClient();
    const [activeModal, setActiveModal] = useState<ActiveModal>(null);
    // ID 76: a Lost-type call outcome opens Mark Lost with the reason pre-filled.
    const [lostPrefill, setLostPrefill] = useState<LostReason | null>(null);
    const [staleInfo, setStaleInfo] = useState<{
        currentOwnerName?: string | null;
        currentUpdatedAt?: string | null;
    } | null>(null);

    const query = useQuery<{ success: true; data: LeadDetailBundle }>({
        queryKey: ["inside-sales-lead", leadId],
        queryFn: async () => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}`, { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load lead");
            return res.json();
        },
        refetchOnWindowFocus: true,
    });

    const invalidate = useCallback(() => {
        qc.invalidateQueries({ queryKey: ["inside-sales-lead", leadId] });
        qc.invalidateQueries({ queryKey: ["inside-sales-queue"] });
        qc.invalidateQueries({ queryKey: ["inside-sales-counts"] });
    }, [qc, leadId]);

    const onActionSuccess = useCallback(() => {
        setActiveModal(null);
        setStaleInfo(null);
        invalidate();
    }, [invalidate]);

    const onStaleConflict = useCallback((info: { currentOwnerName?: string | null; currentUpdatedAt?: string | null }) => {
        setStaleInfo(info);
    }, []);

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
                <Link href={backHref} className="mt-4 inline-flex items-center gap-1 text-sm text-blue-700 hover:underline">
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
            <LeadDetailHeader
                bundle={bundle}
                viewerId={viewerId}
                viewerRole={viewerRole}
                backHref={backHref}
                onUpdated={invalidate}
                statusModalActions={["mark_converted", "mark_lost", "transfer_asm"]}
                onStatusModal={(a) => setActiveModal(a)}
            />

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
                <LeadActivityPanes
                    leadId={leadId}
                    bundle={bundle}
                    canExportHistory={canExportLeadHistory({
                        role: viewerRole,
                        userId: viewerId,
                        currentOwnerId: lead.current_owner_id,
                    })}
                />
                <LeadDetailRightPane bundle={bundle} />
            </div>

            <LeadActionBar
                bundle={bundle}
                isOwner={isOwner}
                viewerRole={viewerRole}
                onAction={setActiveModal}
                onChanged={invalidate}
            />

            {/* Modals — render only when active to keep the tree small. */}
            <LogTouchpointModal
                open={activeModal === "touchpoint"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                lead={lead}
                onSuccess={onActionSuccess}
                onStaleConflict={onStaleConflict}
                updatedAt={updatedAt}
                hasQuote={bundle.commercials_history.some(
                    (c) => (c.event_type === "quote_issue" || c.event_type === "quote_revision") && !c.withdrawn_at,
                )}
                onLostOutcome={(r) => {
                    setLostPrefill(r);
                    setActiveModal("mark_lost");
                }}
            />
            <UpdateCommercialsModal
                open={activeModal === "commercials"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                currentCommercials={bundle.current_commercials}
                onSuccess={onActionSuccess}
            />
            <TransferAsmModal
                open={activeModal === "transfer_asm"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                state={lead.state}
                city={lead.city}
                onSuccess={onActionSuccess}
            />
            <MarkLostModal
                key={lostPrefill ?? "none"}
                open={activeModal === "mark_lost"}
                onClose={() => {
                    setActiveModal(null);
                    setLostPrefill(null);
                }}
                leadId={leadId}
                onSuccess={onActionSuccess}
                defaultReason={lostPrefill}
            />
            <MarkConvertedModal
                open={activeModal === "mark_converted"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                onSuccess={onActionSuccess}
                hasApprovedQuote={hasApprovedQuote(bundle.commercials_history)}
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
            <ClaimLeadConfirm
                open={activeModal === "claim"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                dealerName={lead.dealer_name ?? lead.shop_name ?? "this lead"}
                onSuccess={onActionSuccess}
            />
        </div>
    );
}
