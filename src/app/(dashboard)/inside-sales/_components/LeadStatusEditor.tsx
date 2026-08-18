"use client";

// Editable lead-status chip in the lead-detail header (replaces the old
// temperature editor there). Offers EVERY other status — there is no transition
// gate any more, so a rep can move a lead wherever the conversation went,
// including reopening a closed one. Intermediate statuses are saved as a
// status_change_note touchpoint so the status history stays server-side;
// Converted / Lost / Transferred_to_ASM have dedicated flows (onboarding, lost
// reason, ASM pick) and delegate to the parent view's existing modals via
// onModalAction.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { TRANSITION_MAP, type LeadStatus } from "@/lib/lifecycle/transitions";

export type StatusModalAction = "mark_converted" | "mark_lost" | "transfer_asm";

const MODAL_TARGETS: Partial<Record<LeadStatus, StatusModalAction>> = {
    Converted: "mark_converted",
    Lost: "mark_lost",
    Transferred_to_ASM: "transfer_asm",
};

// Statuses settable directly from the header. New_Unassigned is excluded — it
// is the pre-assignment state, and setting it on an owned lead would strand it
// outside every queue; claim / assignment set it through their own routes.
const DIRECT_TARGETS: LeadStatus[] = [
    "Assigned_Not_Contacted",
    "Under_Discussion",
    "Commercials_Explained",
    "Commercials_Finalised",
    "Awaiting_Customer_Decision",
];

type Props = {
    leadId: string;
    status: string | null | undefined;
    editable: boolean;
    // Dedicated-flow modals the parent view can open (ASM has no transfer_asm).
    modalActions?: StatusModalAction[];
    onModalAction?: (action: StatusModalAction) => void;
    onUpdated?: () => void;
};

export function LeadStatusEditor({
    leadId,
    status,
    editable,
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
    const directOptions = legalTargets.filter((t) => DIRECT_TARGETS.includes(t));
    const modalOptions = legalTargets.filter((t) => {
        const action = MODAL_TARGETS[t];
        return action && modalActions.includes(action);
    });

    if (!editable || (directOptions.length === 0 && modalOptions.length === 0)) {
        return <StatusChip status={from} />;
    }

    const saveDirect = async (to: LeadStatus) => {
        setSaving(true);
        try {
            const res = await fetch(
                `/api/inside-sales/lead/${encodeURIComponent(leadId)}/touchpoint`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        touchpoint_type: "status_change_note",
                        remarks: reason.trim() || undefined,
                        status_change: {
                            to,
                            reason_notes: reason.trim() || null,
                        },
                    }),
                },
            );
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to update status");
            toast.success("Lead status updated");
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
                        Update lead status
                    </p>
                    <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Reason (optional)"
                        className="mb-2 w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-gray-400 focus:outline-none"
                    />
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
                        {modalOptions.map((t) => (
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
