"use client";

// Lead-status chip in the lead-detail header. Since 29 Sep 2026 (ID 80) a rep
// sets no status by hand: the chip only opens the dedicated flows — Mark Won
// (GSTIN), Mark Lost (reason), Transfer to ASM — via onModalAction. Every other
// move comes from an event (calls, quotes, visits, approvals).
// An admin or the Sales Head gets "Correct status": a required reason, logged
// (POST /api/admin/leads/[id]/correct-status) — the only override. It still
// asks for what Mark Lost enforces (ID 57): a lost reason for Lost. It does not
// offer Won or Converted (ID 133): Won is Mark Won, and Converted comes only
// from approval of the dealer's onboarding.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { LOST_REASON_LABELS } from "./modals/MarkLostModal";
import { LEAD_STATUS, LOST_REASON, TRANSITION_MAP, type LeadStatus, type LostReason } from "@/lib/lifecycle/transitions";
import { correctionAllowedTo } from "@/lib/leads/correctStatus";

export type StatusModalAction = "mark_converted" | "mark_lost" | "transfer_asm";

const MODAL_TARGETS: Partial<Record<LeadStatus, StatusModalAction>> = {
    Won: "mark_converted",
    Lost: "mark_lost",
    Transferred_to_ASM: "transfer_asm",
};

// ID 57: corrections that need a detail before they can be saved.
const NEEDS_DETAILS: readonly LeadStatus[] = ["Lost"];


type Props = {
    leadId: string;
    status: string | null | undefined;
    editable: boolean;
    /** Admin / Sales Head: "Correct status" with a reason (ID 80). */
    canCorrect?: boolean;
    // Dedicated-flow modals the parent view can open (ASM has no transfer_asm).
    modalActions?: StatusModalAction[];
    onModalAction?: (action: StatusModalAction) => void;
    onUpdated?: () => void;
};

export function LeadStatusEditor({
    leadId,
    status,
    editable,
    canCorrect = false,
    modalActions = [],
    onModalAction,
    onUpdated,
}: Props) {
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState("");
    const [saving, setSaving] = useState(false);
    // Admin correction to Lost: picked, waiting for its reason.
    const [pending, setPending] = useState<LeadStatus | null>(null);
    const [lostReason, setLostReason] = useState<LostReason | "">("");
    const [competitor, setCompetitor] = useState("");
    const ref = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const from = (status ?? null) as LeadStatus | null;
    const legalTargets = from ? TRANSITION_MAP[from] ?? [] : [];
    // ID 80: only an admin correction sets a status directly. ID 133: never
    // to Won or Converted — the server refuses both.
    const directOptions = canCorrect ? LEAD_STATUS.filter((t) => t !== from && correctionAllowedTo(t)) : [];
    const modalOptions = legalTargets.filter((t) => {
        const action = MODAL_TARGETS[t];
        return action && modalActions.includes(action);
    });

    const visibleModal = editable ? modalOptions : [];
    if (!(editable || canCorrect) || (directOptions.length === 0 && visibleModal.length === 0)) {
        return <StatusChip status={from} />;
    }

    const resetCorrection = () => {
        setReason("");
        setPending(null);
        setLostReason("");
        setCompetitor("");
    };

    const saveDirect = async (to: LeadStatus) => {
        if (reason.trim().length < 5) {
            toast.error("Correct status needs a reason (at least 5 characters).");
            return;
        }
        if (to === "Lost" && !lostReason) {
            toast.error("Pick a Lost reason.");
            return;
        }
        if (to === "Lost" && lostReason === "lost_to_competition" && !competitor.trim()) {
            toast.error("Name the competitor.");
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(
                `/api/admin/leads/${encodeURIComponent(leadId)}/correct-status`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        to,
                        reason: reason.trim(),
                        lost_reason: to === "Lost" ? lostReason : undefined,
                        competitor_name:
                            to === "Lost" && lostReason === "lost_to_competition" ? competitor.trim() : undefined,
                    }),
                },
            );
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to update status");
            toast.success("Status corrected");
            setOpen(false);
            resetCorrection();
            onUpdated?.();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const openModal = (to: LeadStatus) => {
        const action = MODAL_TARGETS[to];
        if (!action) return;
        setOpen(false);
        resetCorrection();
        onModalAction?.(action);
    };

    return (
        <span ref={ref} className="relative inline-flex items-center">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                title="Update lead status"
                className="inline-flex items-center gap-1"
            >
                <StatusChip status={from} />
                <Pencil className="h-3 w-3 text-gray-400 transition-colors hover:text-gray-600" />
            </button>

            {open && (
                <div className="absolute left-0 top-7 z-50 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                        {canCorrect ? "Correct status" : "Close or transfer"}
                    </p>
                    {canCorrect && (
                    <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Reason (required)"
                        className="mb-2 w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-gray-400 focus:outline-none"
                    />
                    )}
                    <div className="flex flex-col gap-1">
                        {directOptions.map((t) => (
                            <button
                                key={t}
                                type="button"
                                disabled={saving}
                                onClick={() => (NEEDS_DETAILS.includes(t) ? setPending(t) : saveDirect(t))}
                                className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-gray-50 disabled:opacity-50 ${
                                    pending === t ? "border-gray-400 bg-gray-50" : "border-gray-200"
                                }`}
                            >
                                <StatusChip status={t} size="sm" />
                                {NEEDS_DETAILS.includes(t) && (
                                    <span className="text-[10px] text-gray-400">needs reason</span>
                                )}
                            </button>
                        ))}
                        {pending && (
                            <div className="my-1 space-y-2 rounded-md border border-gray-200 bg-gray-50 p-2">
                                <select
                                    value={lostReason}
                                    onChange={(e) => setLostReason(e.target.value as LostReason | "")}
                                    className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs focus:border-gray-400 focus:outline-none"
                                >
                                    <option value="">Lost reason (required)</option>
                                    {LOST_REASON.map((r) => (
                                        <option key={r} value={r}>{LOST_REASON_LABELS[r]}</option>
                                    ))}
                                </select>
                                {lostReason === "lost_to_competition" && (
                                    <input
                                        value={competitor}
                                        onChange={(e) => setCompetitor(e.target.value)}
                                        placeholder="Competitor (required)"
                                        className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs focus:border-gray-400 focus:outline-none"
                                    />
                                )}
                                <button
                                    type="button"
                                    disabled={saving}
                                    onClick={() => saveDirect(pending)}
                                    className="w-full rounded-md bg-gray-900 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
                                >
                                    {saving ? "Saving…" : `Correct to ${pending.replace(/_/g, " ")}`}
                                </button>
                            </div>
                        )}
                        {visibleModal.map((t) => (
                            <button
                                key={t}
                                type="button"
                                disabled={saving}
                                onClick={() => openModal(t)}
                                className="flex items-center justify-between rounded-md border border-gray-200 px-2 py-1.5 text-left transition-colors hover:bg-gray-50 disabled:opacity-50"
                            >
                                <StatusChip status={t} size="sm" />
                                <span className="text-[10px] text-gray-400">opens form…</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </span>
    );
}
