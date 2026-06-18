"use client";

import {
    MessageSquarePlus,
    Receipt,
    Send,
    Repeat,
    AlertCircle,
    CheckCircle2,
    XCircle,
    UserPlus2,
} from "lucide-react";
import type { LeadDetailBundle } from "@/lib/inside-sales/types";
import { isOpen, isTerminal, type LeadStatus } from "@/lib/lifecycle/transitions";
import type { ActiveModal } from "./LeadDetailView";

type Props = {
    bundle: LeadDetailBundle;
    isOwner: boolean;
    viewerRole: string;
    onAction: (modal: ActiveModal) => void;
};

export function LeadActionBar({ bundle, isOwner, viewerRole, onAction }: Props) {
    const lead = bundle.lead;
    const status = lead.lead_status as LeadStatus | null;
    const isUnassigned = !lead.current_owner_id && !(status && isTerminal(status));
    const open = status ? isOpen(status) : false;
    const isAdmin = viewerRole === "admin" || viewerRole === "ceo";

    // Claim banner shows when lead is unassigned — visible to any IS rep + admin.
    if (isUnassigned) {
        return (
            <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-6 py-3 flex items-center justify-between gap-4">
                <div className="text-sm text-gray-700">
                    <span className="font-medium">Unassigned lead.</span> Claim it to start working.
                </div>
                <button
                    type="button"
                    onClick={() => onAction("claim")}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition"
                >
                    <UserPlus2 className="h-4 w-4" />
                    Claim Lead
                </button>
            </div>
        );
    }

    // Non-owner — show informational state with no buttons (CEO / admin / other rep).
    if (!isOwner) {
        const helper = isAdmin
            ? "Admin/CEO — reassign first to modify."
            : "Read-only — you are not the current owner.";
        return (
            <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-6 py-3 text-xs text-gray-500">
                {helper}
            </div>
        );
    }

    // Owner action bar.
    const canTransferAsm = open && status !== "Transferred_to_ASM";
    // A lead can be marked Converted from any open status (no funnel/price gate).
    const canMarkConverted = open;

    return (
        <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            <ActionButton primary icon={MessageSquarePlus} onClick={() => onAction("touchpoint")}>
                Log Touchpoint
            </ActionButton>
            <ActionButton icon={Receipt} onClick={() => onAction("commercials")}>
                Update Commercials
            </ActionButton>
            <ActionButton
                icon={Send}
                onClick={() => onAction("transfer_asm")}
                disabled={!canTransferAsm}
                disabledReason={!open ? "Lead is closed" : "Already transferred"}
            >
                Transfer to ASM
            </ActionButton>
            <ActionButton
                icon={CheckCircle2}
                tone="emerald"
                onClick={() => onAction("mark_converted")}
                disabled={!canMarkConverted}
                disabledReason={!canMarkConverted ? "Lead is already closed" : undefined}
            >
                Mark Converted
            </ActionButton>
            <ActionButton
                icon={XCircle}
                tone="rose"
                onClick={() => onAction("mark_lost")}
                disabled={!open}
                disabledReason={!open ? "Lead is already terminal" : undefined}
            >
                Mark Lost
            </ActionButton>
            <ActionButton icon={Repeat} onClick={() => onAction("reassign")}>
                Reassign
            </ActionButton>
            <ActionButton
                icon={AlertCircle}
                tone="amber"
                onClick={() => onAction("escalate")}
                disabled={!open}
                disabledReason={!open ? "Lead is already terminal" : undefined}
            >
                Escalate
            </ActionButton>
        </div>
    );
}

function ActionButton({
    children,
    icon: Icon,
    primary,
    tone = "blue",
    onClick,
    disabled,
    disabledReason,
}: {
    children: React.ReactNode;
    icon: React.ComponentType<{ className?: string }>;
    primary?: boolean;
    tone?: "blue" | "emerald" | "rose" | "amber" | "gray";
    onClick: () => void;
    disabled?: boolean;
    disabledReason?: string;
}) {
    const tones: Record<string, string> = {
        blue: primary ? "bg-blue-600 text-white hover:bg-blue-700" : "border-blue-200 text-blue-700 hover:bg-blue-50",
        emerald: "border-emerald-200 text-emerald-700 hover:bg-emerald-50",
        rose: "border-rose-200 text-rose-700 hover:bg-rose-50",
        amber: "border-amber-200 text-amber-700 hover:bg-amber-50",
        gray: "border-gray-200 text-gray-700 hover:bg-gray-50",
    };
    const base = primary ? "" : "bg-white border";
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={disabled ? disabledReason : undefined}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition ${base} ${tones[tone]} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
            <Icon className="h-3.5 w-3.5" />
            {children}
        </button>
    );
}
