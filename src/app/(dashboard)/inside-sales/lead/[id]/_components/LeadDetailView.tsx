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
import { ReassignLeadModal, type TeamTarget } from "../../../_components/modals/ReassignLeadModal";
import { ReassignToIsrModal } from "../../../_components/modals/ReassignToIsrModal";
import { EscalateModal } from "../../../_components/modals/EscalateModal";
import { ClaimLeadConfirm } from "../../../_components/modals/ClaimLeadConfirm";
import { canExportLeadHistory } from "@/lib/leads/access";
import { CallbackBriefCard } from "@/components/leads/callback-brief-card";

export const LEAD_NOT_ACCESSIBLE =
    "This lead is not assigned to you any more — it may have been transferred to another owner. Ask your manager if you still need it.";

export type ActiveModal =
    | null
    | "touchpoint"
    | "commercials"
    | "transfer_asm"
    | "mark_lost"
    | "mark_converted"
    | "reassign"
    // ID 179: a manager's "Reassign to ISR" (Leads page rules).
    | "reassign_isr"
    | "escalate"
    | "claim";

/** ID 155: the roles POST/GET /api/inside-sales/lead/[id]/reassign accept (its MUTATE_ROLES). */
const TEAM_REASSIGN_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

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
            // ID 45: a rep reads only leads they currently own, so a 404 here is
            // usually an old bell link to a lead since transferred (e.g. to an ASM).
            if (res.status === 404) throw new Error(LEAD_NOT_ACCESSIBLE);
            if (!res.ok) throw new Error("Failed to load lead");
            return res.json();
        },
        retry: (count, err) => (err as Error).message !== LEAD_NOT_ACCESSIBLE && count < 3,
        refetchOnWindowFocus: true,
    });

    // ID 155: a manager viewing a direct report's lead may move it within the
    // team. Asked only when the viewer is not the owner and their role can
    // reach the reassign route at all.
    const ownerId = query.data?.data?.lead?.current_owner_id ?? null;
    const teamQuery = useQuery<{ can_team_reassign: boolean; targets: TeamTarget[] }>({
        queryKey: ["inside-sales-lead", leadId, "team-reassign", ownerId],
        enabled: !!ownerId && ownerId !== viewerId && TEAM_REASSIGN_ROLES.includes(viewerRole),
        queryFn: async () => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/reassign`, { cache: "no-store" });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) return { can_team_reassign: false, targets: [] };
            return json.data;
        },
    });
    const canTeamReassign = Boolean(teamQuery.data?.can_team_reassign && teamQuery.data.targets.length > 0);

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

            {/* D8 — the promised callback and its brief, before anything else. */}
            <CallbackBriefCard leadId={leadId} className="mx-6 mt-3" />

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
                <LeadDetailRightPane bundle={bundle} viewerRole={viewerRole} />
            </div>

            <LeadActionBar
                bundle={bundle}
                isOwner={isOwner}
                viewerRole={viewerRole}
                onAction={setActiveModal}
                onChanged={invalidate}
                canTeamReassign={!isOwner && canTeamReassign}
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
                onOpenCommercials={() => setActiveModal("commercials")}
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
                teamTargets={!isOwner && canTeamReassign ? teamQuery.data?.targets : undefined}
            />
            <ReassignToIsrModal
                open={activeModal === "reassign_isr"}
                onClose={() => setActiveModal(null)}
                leadId={leadId}
                currentOwnerId={lead.current_owner_id ?? null}
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
