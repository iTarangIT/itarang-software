"use client";

// Lead-status chip in the lead-detail header. Since 29 Sep 2026 (ID 80) a rep
// sets no status by hand: the chip only opens the dedicated flows — Mark Won
// (GSTIN), Mark Lost (reason), Transfer to ASM — via onModalAction. Every other
// move comes from an event (calls, quotes, visits, approvals).
// An admin gets "Correct status": any status, a required reason, logged
// (POST /api/admin/leads/[id]/correct-status) — the only override.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { LEAD_STATUS, TRANSITION_MAP, type LeadStatus } from "@/lib/lifecycle/transitions";

export type StatusModalAction = "mark_converted" | "mark_lost" | "transfer_asm";

const MODAL_TARGETS: Partial<Record<LeadStatus, StatusModalAction>> = {
    Won: "mark_converted",
    Lost: "mark_lost",
    Transferred_to_ASM: "transfer_asm",
};


type Props = {
    leadId: string;
    status: string | null | undefined;
    editable: boolean;
    /** Admin / CEO: "Correct status" with a reason (ID 80). */
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
    // ID 80: only an admin correction sets a status directly — to any status.
    const directOptions = canCorrect ? LEAD_STATUS.filter((t) => t !== from) : [];
    const modalOptions = legalTargets.filter((t) => {
        const action = MODAL_TARGETS[t];
        return action && modalActions.includes(action);
    });

    const visibleModal = editable ? modalOptions : [];
    if (!(editable || canCorrect) || (directOptions.length === 0 && visibleModal.length === 0)) {
        return <StatusChip status={from} />;
    }

    const saveDirect = async (to: LeadStatus) => {
        if (reason.trim().length < 5) {
            toast.error("Correct status needs a reason (at least 5 characters).");
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(
                `/api/admin/leads/${encodeURIComponent(leadId)}/correct-status`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ to, reason: reason.trim() }),
                },
            );
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to update status");
            toast.success("Status corrected");
            setOpen(false);
            setReason("");
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
        setReason("");
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
                        {canCorrect ? "Correct status (admin)" : "Close or transfer"}
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
                                onClick={() => saveDirect(t)}
                                className="flex items-center rounded-md border border-gray-200 px-2 py-1.5 text-left transition-colors hover:bg-gray-50 disabled:opacity-50"
                            >
                                <StatusChip status={t} size="sm" />
                            </button>
                        ))}
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
