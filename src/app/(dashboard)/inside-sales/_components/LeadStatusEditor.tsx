"use client";

// Lead-status chip in the lead-detail header. Since 29 Sep 2026 (ID 80) a rep
// sets no status by hand: the chip only opens the dedicated flows — Mark Won
// (GSTIN), Mark Lost (reason), Transfer to ASM — via onModalAction. Every other
// move comes from an event (calls, quotes, visits, approvals).
//
// Since 9 Oct (ID 136) nobody else picks a status either: "Correct status" for
// the admin and the Sales Head is gone. A mistake has its own action — Undo
// Mark Won (ID 134), Change Lost reason, Reactivate — in the lead header.

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { TRANSITION_MAP, type LeadStatus } from "@/lib/lifecycle/transitions";

export type StatusModalAction = "mark_converted" | "mark_lost" | "transfer_asm";

const MODAL_TARGETS: Partial<Record<LeadStatus, StatusModalAction>> = {
    Won: "mark_converted",
    Lost: "mark_lost",
    Transferred_to_ASM: "transfer_asm",
};

type Props = {
    status: string | null | undefined;
    editable: boolean;
    // Dedicated-flow modals the parent view can open (ASM has no transfer_asm).
    modalActions?: StatusModalAction[];
    onModalAction?: (action: StatusModalAction) => void;
};

export function LeadStatusEditor({ status, editable, modalActions = [], onModalAction }: Props) {
    const [open, setOpen] = useState(false);
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
    const modalOptions = legalTargets.filter((t) => {
        const action = MODAL_TARGETS[t];
        return action && modalActions.includes(action);
    });

    if (!editable || modalOptions.length === 0) {
        return <StatusChip status={from} />;
    }

    const openModal = (to: LeadStatus) => {
        const action = MODAL_TARGETS[to];
        if (!action) return;
        setOpen(false);
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
                        Close or transfer
                    </p>
                    <div className="flex flex-col gap-1">
                        {modalOptions.map((t) => (
                            <button
                                key={t}
                                type="button"
                                onClick={() => openModal(t)}
                                className="flex items-center justify-between rounded-md border border-gray-200 px-2 py-1.5 text-left transition-colors hover:bg-gray-50"
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
