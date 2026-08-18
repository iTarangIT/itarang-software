"use client";

import {
    MapPinned,
    MessageSquarePlus,
    Receipt,
    Repeat,
    AlertCircle,
    CheckCircle2,
    XCircle,
} from "lucide-react";
import type { LeadDetailBundle } from "@/lib/inside-sales/types";
import { isOpen, type LeadStatus } from "@/lib/lifecycle/transitions";

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
    bundle: LeadDetailBundle;
    isOwner: boolean;
    viewerRole: string;
    onAction: (modal: ActiveModal) => void;
};

export function AsmLeadActionBar({ bundle, isOwner, viewerRole, onAction }: Props) {
    const lead = bundle.lead;
    const status = lead.lead_status as LeadStatus | null;
    const open = status ? isOpen(status) : false;
    const isAdmin = viewerRole === "admin" || viewerRole === "ceo";

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

    // Converted / Lost are not gated on the current status — an ASM can reopen a
    // lead closed by mistake, the same freedom the status dropdown gives.
    // Escalate stays open-only because its route refuses a closed lead.

    return (
        <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            <Btn primary tone="emerald" icon={MapPinned} onClick={() => onAction("visit")}>
                Log Visit
            </Btn>
            <Btn icon={MessageSquarePlus} onClick={() => onAction("touchpoint")}>
                Log Touchpoint
            </Btn>
            <Btn icon={Receipt} onClick={() => onAction("commercials")}>
                Update Commercials
            </Btn>
            <Btn
                tone="emerald"
                icon={CheckCircle2}
                onClick={() => onAction("mark_converted")}
            >
                Mark Converted
            </Btn>
            <Btn
                tone="rose"
                icon={XCircle}
                onClick={() => onAction("mark_lost")}
            >
                Mark Lost
            </Btn>
            <Btn icon={Repeat} onClick={() => onAction("reassign")}>
                Reassign
            </Btn>
            <Btn
                tone="amber"
                icon={AlertCircle}
                onClick={() => onAction("escalate")}
                disabled={!open}
                disabledReason={!open ? "Lead is already terminal" : undefined}
            >
                Escalate
            </Btn>
        </div>
    );
}

function Btn({
    children,
    icon: Icon,
    primary,
    tone = "gray",
    onClick,
    disabled,
    disabledReason,
}: {
    children: React.ReactNode;
    icon: React.ComponentType<{ className?: string }>;
    primary?: boolean;
    tone?: "emerald" | "rose" | "amber" | "gray";
    onClick: () => void;
    disabled?: boolean;
    disabledReason?: string;
}) {
    const tones: Record<string, string> = {
        emerald: primary
            ? "bg-emerald-600 text-white hover:bg-emerald-700"
            : "border-emerald-200 text-emerald-700 hover:bg-emerald-50",
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
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition ${base} ${tones[tone]} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
            <Icon className="h-3.5 w-3.5" />
            {children}
        </button>
    );
}
