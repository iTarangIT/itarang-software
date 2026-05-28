"use client";

// BRD §0.6 — escalation resolution thread. Left: full touchpoint + status
// history (reused from Module 1). Right: escalation detail, CEO advisory
// (authored here by the CEO — Module 4), and the admin resolution action.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
    AlertTriangle,
    ArrowLeft,
    CheckCircle2,
    Loader2,
    MessageSquare,
    Sparkles,
} from "lucide-react";
import { TouchpointHistoryPane } from "@/app/(dashboard)/inside-sales/lead/[id]/_components/TouchpointHistoryPane";
import { StatusChip } from "@/app/(dashboard)/inside-sales/_components/StatusChip";
import { Button } from "@/components/ui/button";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import type { EscalationThreadBundle } from "@/lib/admin/types";
import { UrgencyChip, humanize } from "../../_components/escalationUi";
import { ResolveEscalationModal } from "../../_components/ResolveEscalationModal";
import { CeoAdvisoryModal } from "../../_components/CeoAdvisoryModal";

function fmt(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "—";
    }
}

export function EscalationDetailView({
    escalationId,
    viewerRole,
}: {
    escalationId: string;
    viewerRole: string;
}) {
    const qc = useQueryClient();
    const [modalOpen, setModalOpen] = useState(false);
    const [ceoModalOpen, setCeoModalOpen] = useState(false);

    const query = useQuery<{ success: true; data: EscalationThreadBundle }>({
        queryKey: ["admin-escalation", escalationId],
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/escalations/${escalationId}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load escalation");
            return res.json();
        },
    });

    if (query.isLoading) {
        return (
            <div className="px-6 py-10 flex items-center justify-center text-ink-muted">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading escalation…
            </div>
        );
    }
    if (query.error || !query.data?.data) {
        return (
            <div className="px-6 py-10 max-w-2xl">
                <div className="rounded-lg border border-danger/30 bg-danger-bg p-4 flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-danger shrink-0" />
                    <div className="text-sm text-danger">
                        {(query.error as Error | undefined)?.message ??
                            "Escalation not found."}
                    </div>
                </div>
                <Link
                    href="/admin/escalations"
                    className="mt-4 inline-flex items-center gap-1 text-sm text-warning hover:underline"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to escalations
                </Link>
            </div>
        );
    }

    const { escalation: e, lead, touchpoints, status_history } = query.data.data;
    const isPending = e.status === "pending_review";
    const canResolve = isPending && (viewerRole === "admin" || viewerRole === "sales_head");
    const hasCeoInput = !!(e.ceo_comment || e.ceo_recommendation);

    return (
        <div className="px-6 md:px-8 py-6 space-y-4 max-w-[1500px]">
            <div>
                <Link
                    href="/admin/escalations"
                    className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to escalations
                </Link>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-5 items-start">
                {/* Left — unified history */}
                <div className="rounded-xl border border-border bg-surface shadow-card overflow-hidden">
                    <div className="px-4 py-3 border-b border-border">
                        <h2 className="text-sm font-semibold text-ink">
                            Lead History
                        </h2>
                    </div>
                    <div className="h-[70vh] overflow-y-auto">
                        <TouchpointHistoryPane
                            touchpoints={touchpoints}
                            statusHistory={status_history}
                        />
                    </div>
                </div>

                {/* Right — escalation detail + resolution */}
                <div className="space-y-4">
                    {/* Lead summary */}
                    <div className="rounded-xl border border-border bg-surface shadow-card p-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <Link
                                    href={`/inside-sales/lead/${lead.id}`}
                                    className="text-base font-semibold text-brand-700 hover:underline"
                                >
                                    {lead.dealer_name || "(unnamed dealer)"}
                                </Link>
                                <div className="text-xs text-ink-muted mt-0.5">
                                    {lead.phone || "—"}
                                    {lead.city ? ` · ${lead.city}` : ""}
                                    {lead.state ? `, ${lead.state}` : ""}
                                </div>
                            </div>
                            <StatusChip
                                status={lead.lead_status as LeadStatus | null}
                            />
                        </div>
                        <div className="mt-2 text-xs text-ink-muted">
                            Current owner:{" "}
                            <span className="text-ink">
                                {lead.current_owner_name || "Unassigned"}
                            </span>
                        </div>
                    </div>

                    {/* Escalation detail */}
                    <div className="rounded-xl border border-warning/30 bg-warning-bg/40 shadow-card p-4 space-y-2.5">
                        <div className="flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 text-warning" />
                            <h3 className="text-sm font-semibold text-warning capitalize">
                                {humanize(e.escalation_reason)}
                            </h3>
                            <span className="ml-auto">
                                <UrgencyChip urgency={e.urgency} />
                            </span>
                        </div>
                        <p className="text-sm text-ink whitespace-pre-wrap">
                            {e.escalation_notes}
                        </p>
                        {e.suggested_action && (
                            <div className="text-xs text-ink-muted">
                                <span className="font-medium">
                                    Suggested action:
                                </span>{" "}
                                {e.suggested_action}
                            </div>
                        )}
                        <div className="text-[11px] text-ink-muted pt-1 border-t border-warning/30">
                            Raised by {e.raised_by_name || "—"} ·{" "}
                            {fmt(e.raised_at)}
                        </div>
                    </div>

                    {/* CEO advisory (read-only — Module 4 authors it) */}
                    {hasCeoInput && (
                        <div className="rounded-xl border border-violet-200 bg-violet-50/60 shadow-card p-4 space-y-2">
                            <div className="flex items-center gap-2 text-violet-800">
                                <Sparkles className="h-4 w-4" />
                                <h3 className="text-sm font-semibold">
                                    CEO Advisory
                                </h3>
                            </div>
                            {e.ceo_recommendation && (
                                <div className="text-sm text-violet-900">
                                    <span className="font-semibold">
                                        Recommendation:
                                    </span>{" "}
                                    {e.ceo_recommendation}
                                </div>
                            )}
                            {e.ceo_comment && (
                                <div className="text-sm text-ink flex items-start gap-1.5">
                                    <MessageSquare className="h-3.5 w-3.5 mt-0.5 text-violet-400 shrink-0" />
                                    <span className="whitespace-pre-wrap">
                                        {e.ceo_comment}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Resolution state / action */}
                    {isPending ? (
                        <div className="rounded-xl border border-border bg-surface shadow-card p-4">
                            {canResolve ? (
                                <Button
                                    type="button"
                                    className="w-full"
                                    onClick={() => setModalOpen(true)}
                                >
                                    Resolve Escalation
                                </Button>
                            ) : viewerRole === "ceo" ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="w-full"
                                    onClick={() => setCeoModalOpen(true)}
                                >
                                    {hasCeoInput
                                        ? "Update CEO Advisory"
                                        : "Add CEO Advisory"}
                                </Button>
                            ) : (
                                <p className="text-xs text-ink-muted text-center">
                                    Pending admin resolution.
                                </p>
                            )}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-success/30 bg-success-bg/60 shadow-card p-4 space-y-1.5">
                            <div className="flex items-center gap-2 text-success">
                                <CheckCircle2 className="h-4 w-4" />
                                <h3 className="text-sm font-semibold capitalize">
                                    Resolved — {humanize(e.resolution_action)}
                                </h3>
                            </div>
                            {e.resolution_notes && (
                                <p className="text-sm text-ink whitespace-pre-wrap">
                                    {e.resolution_notes}
                                </p>
                            )}
                            <div className="text-[11px] text-ink-muted">
                                By {e.resolved_by_name || "—"} ·{" "}
                                {fmt(e.resolved_at)}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <ResolveEscalationModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                escalationId={escalationId}
                onSuccess={() => {
                    setModalOpen(false);
                    qc.invalidateQueries({
                        queryKey: ["admin-escalation", escalationId],
                    });
                    qc.invalidateQueries({ queryKey: ["admin-escalations"] });
                    qc.invalidateQueries({ queryKey: ["admin-dashboard"] });
                }}
            />

            <CeoAdvisoryModal
                open={ceoModalOpen}
                onClose={() => setCeoModalOpen(false)}
                escalationId={escalationId}
                existingComment={e.ceo_comment}
                onSuccess={() => {
                    setCeoModalOpen(false);
                    qc.invalidateQueries({
                        queryKey: ["admin-escalation", escalationId],
                    });
                }}
            />
        </div>
    );
}
