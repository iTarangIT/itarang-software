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
import { useState } from "react";
import { toast } from "sonner";
import { Ban } from "lucide-react";
import type { LeadDetailBundle } from "@/lib/inside-sales/types";
import { isOpen, type LeadStatus } from "@/lib/lifecycle/transitions";
import { CallNowButton } from "@/components/leads/call-now-button";

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
    /** Refresh after an inline action (Visit not needed). */
    onChanged?: () => void;
};

export function AsmLeadActionBar({ bundle, isOwner, viewerRole, onAction, onChanged }: Props) {
    const lead = bundle.lead;
    const [savingNotNeeded, setSavingNotNeeded] = useState(false);

    // ID 77: Awaiting field visit ends only with a visit or "Visit not needed" + reason.
    const visitNotNeeded = async () => {
        const reason = window.prompt("Why is a field visit not needed? (at least 5 characters)")?.trim();
        if (!reason) return;
        if (reason.length < 5) {
            toast.error("Give a reason of at least 5 characters.");
            return;
        }
        setSavingNotNeeded(true);
        try {
            const res = await fetch(`/api/asm/lead/${encodeURIComponent(lead.id)}/visit-not-needed`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Could not save");
            toast.success("Visit marked not needed.");
            onChanged?.();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSavingNotNeeded(false);
        }
    };
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

    // Won / Lost are refused server-side for a closed lead (S3, statusRules.ts),
    // so Mark Won and Escalate are disabled on a Lost / Converted lead.

    return (
        <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            <Btn primary tone="emerald" icon={MapPinned} onClick={() => onAction("visit")}>
                Log Visit
            </Btn>
            {status === "Transferred_to_ASM" && (
                <Btn icon={Ban} onClick={visitNotNeeded} disabled={savingNotNeeded}>
                    Visit not needed
                </Btn>
            )}
            <Btn icon={MessageSquarePlus} onClick={() => onAction("touchpoint")}>
                Log Touchpoint
            </Btn>
            <Btn icon={Receipt} onClick={() => onAction("commercials")}>
                Update Commercials
            </Btn>
            {/* ID 83: the owner asks the NeoDove calling team to ring this dealer
                next. The call that follows is marked "called on your behalf". */}
            <CallNowButton
                leadId={lead.id}
                leadName={lead.shop_name || lead.dealer_name || "this lead"}
                disabled={!open}
                onQueued={onChanged}
            />
            <Btn
                tone="emerald"
                icon={CheckCircle2}
                onClick={() => onAction("mark_converted")}
                disabled={!open}
                disabledReason={
                    !open ? `Lead is ${status === "Lost" ? "Lost" : "closed"} — correct its status first` : undefined
                }
            >
                Mark Won
            </Btn>
            {/* ID 115.4: a Won lead goes to Lost only through the admin
                onboarding drop-out review — the server refuses it here. */}
            {status !== "Won" && (
                <Btn
                    tone="rose"
                    icon={XCircle}
                    onClick={() => onAction("mark_lost")}
                >
                    Mark Lost
                </Btn>
            )}
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
