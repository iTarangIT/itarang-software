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
import { CLAIM_ROLES, type LeadDetailBundle } from "@/lib/inside-sales/types";
import { isOpen, isTerminal, type LeadStatus } from "@/lib/lifecycle/transitions";
import type { ActiveModal } from "./LeadDetailView";
import { CallNowButton } from "@/components/leads/call-now-button";

type Props = {
    bundle: LeadDetailBundle;
    isOwner: boolean;
    viewerRole: string;
    onAction: (modal: ActiveModal) => void;
    /** Refresh the lead after an action that has no modal (Call now). */
    onChanged?: () => void;
};

export function LeadActionBar({ bundle, isOwner, viewerRole, onAction, onChanged }: Props) {
    const lead = bundle.lead;
    const status = lead.lead_status as LeadStatus | null;
    const isUnassigned = !lead.current_owner_id && !(status && isTerminal(status));
    const open = status ? isOpen(status) : false;
    const isAdmin = viewerRole === "admin" || viewerRole === "ceo";

    // Claim banner shows when lead is unassigned — only to the roles the claim
    // route accepts (CLAIM_ROLES). A manager reaching this page (Open lead page)
    // saw the button and got "Forbidden" on click; they assign from Leads.
    const canClaim = (CLAIM_ROLES as readonly string[]).includes(viewerRole);
    if (isUnassigned && !canClaim) {
        return (
            <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-6 py-3 text-xs text-gray-500">
                <span className="font-medium text-gray-700">Unassigned lead.</span> Assign it to a rep from
                Leads (select the lead → Reassign).
            </div>
        );
    }
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

    // Owner action bar. Converted / Lost / Transfer are not gated on the current
    // status — a rep can reopen a lead closed by mistake or re-transfer one, the
    // same freedom the status dropdown gives. Escalate stays open-only because
    // its route refuses a closed lead.

    return (
        <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            <ActionButton primary icon={MessageSquarePlus} onClick={() => onAction("touchpoint")}>
                Log Touchpoint
            </ActionButton>
            <ActionButton icon={Receipt} onClick={() => onAction("commercials")}>
                Update Commercials
            </ActionButton>
            {/* ID 83: the owner asks the NeoDove calling team to ring this dealer
                next. The call that follows is marked "called on your behalf". */}
            <CallNowButton
                leadId={lead.id}
                leadName={lead.shop_name || lead.dealer_name || "this lead"}
                disabled={!open}
                onQueued={onChanged}
            />
            <ActionButton
                icon={Send}
                onClick={() => onAction("transfer_asm")}
            >
                Transfer to ASM
            </ActionButton>
            <ActionButton
                icon={CheckCircle2}
                tone="emerald"
                onClick={() => onAction("mark_converted")}
            >
                Mark Won
            </ActionButton>
            {/* ID 115.4: a Won lead goes to Lost only through the admin
                onboarding drop-out review — the server refuses it here. */}
            {status !== "Won" && (
                <ActionButton
                    icon={XCircle}
                    tone="rose"
                    onClick={() => onAction("mark_lost")}
                >
                    Mark Lost
                </ActionButton>
            )}
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
