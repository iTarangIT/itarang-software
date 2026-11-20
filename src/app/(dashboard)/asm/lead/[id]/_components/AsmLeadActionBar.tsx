"use client";

import {
    ArrowRight,
    MapPinned,
    MessageSquarePlus,
    Receipt,
    Repeat,
    AlertCircle,
    CheckCircle2,
    XCircle,
} from "lucide-react";
import Link from "next/link";
import { Ban } from "lucide-react";
import type { LeadDetailBundle } from "@/lib/inside-sales/types";
import { isOpen, type LeadStatus } from "@/lib/lifecycle/transitions";
import { CallNowButton } from "@/components/leads/call-now-button";
import { CorrectLeadGstinButton } from "@/components/leads/CorrectLeadGstinButton";
import { GSTIN_CORRECTION_MANAGER_ROLES } from "@/lib/leads/correctLeadGstinRules";
import { LeadMoreMenu, type MoreMenuItem } from "@/app/(dashboard)/inside-sales/lead/[id]/_components/LeadMoreMenu";

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
    /** ID 77 Visit not needed — useVisitNotNeeded, shared with the Next step box (ID 246). */
    onVisitNotNeeded: () => void;
    savingNotNeeded?: boolean;
    /** ID 155 / 221: the viewer manages the current owner and may move the lead within their team. */
    canTeamReassign?: boolean;
    /** ID 221: the owner has someone in their team to give the lead to. */
    canOwnerReassign?: boolean;
};

export function AsmLeadActionBar({
    bundle,
    isOwner,
    viewerRole,
    onAction,
    onChanged,
    onVisitNotNeeded,
    savingNotNeeded = false,
    canTeamReassign = false,
    canOwnerReassign = false,
}: Props) {
    const lead = bundle.lead;
    const status = lead.lead_status as LeadStatus | null;
    const open = status ? isOpen(status) : false;
    const isAdmin = viewerRole === "admin" || viewerRole === "ceo";
    // ID 124: a Won lead has no Mark Won — a GSTIN typo is fixed with Correct
    // GSTIN, which updates the lead and its onboarding application together.
    const isWon = status === "Won";
    const correctGstin = (
        <CorrectLeadGstinButton leadId={lead.id} currentGstin={lead.gstin ?? null} onDone={onChanged} />
    );

    if (!isOwner) {
        const helper = isAdmin
            ? "Admin/CEO — reassign first to modify."
            : canTeamReassign
              ? "Your team member's lead — you can move it within your team."
              : "Read-only — you are not the current owner.";
        const managerCanFixGstin = isWon && (GSTIN_CORRECTION_MANAGER_ROLES as readonly string[]).includes(viewerRole);
        return (
            <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-6 py-3 text-xs text-gray-500 flex flex-wrap items-center gap-3">
                <span>{helper}</span>
                {/* ID 155 / 221: the same "Reassign within team" as the ISR lead page. */}
                {canTeamReassign && (
                    <button
                        type="button"
                        onClick={() => onAction("reassign")}
                        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 hover:bg-gray-50"
                    >
                        Reassign within team
                    </button>
                )}
                {managerCanFixGstin && correctGstin}
            </div>
        );
    }

    // Won / Lost are refused server-side for a closed lead (S3, statusRules.ts),
    // so Mark Won and Escalate are disabled on a Lost / Converted lead.
    //
    // ID 246: the bar is grouped by stage — the work buttons on the left, the
    // decision on the right, everything else under More. Each action keeps its
    // handler, its show/hide rule and its disabled reason (244_246 workflows).
    // Continue onboarding: the header's rule (a Won lead whose application is
    // still a draft; once submitted it is with the Sales Head).
    const continueOnboarding =
        (status === "Won" || status === "Converted") &&
        Boolean(lead.dealer_onboarding_application_id) &&
        (lead.onboarding_status ?? "draft").toLowerCase() === "draft";

    const more: MoreMenuItem[] = [
        { key: "touchpoint", label: "Log activity (call / WhatsApp)", icon: MessageSquarePlus, onClick: () => onAction("touchpoint") },
        {
            key: "commercials",
            label: "Update quote",
            icon: Receipt,
            onClick: () => onAction("commercials"),
            hint: "Share a brochure, give or revise a quote, or change terms.",
        },
    ];
    // ID 221: only to someone in the owner's team; nobody under them = no item.
    if (canOwnerReassign) more.push({ key: "reassign", label: "Reassign", icon: Repeat, onClick: () => onAction("reassign") });
    more.push({
        key: "escalate",
        label: "Escalate",
        icon: AlertCircle,
        tone: "amber",
        onClick: () => onAction("escalate"),
        disabled: !open,
        disabledReason: !open ? "This lead is closed" : undefined,
    });

    return (
        <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            {continueOnboarding && (
                <Link
                    href={`/dealer-onboarding?applicationId=${lead.dealer_onboarding_application_id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
                >
                    Continue onboarding
                    <ArrowRight className="h-3.5 w-3.5" />
                </Link>
            )}
            <Btn primary={!continueOnboarding} tone="emerald" icon={MapPinned} onClick={() => onAction("visit")}>
                Log visit
            </Btn>
            {status === "Transferred_to_ASM" && (
                <Btn icon={Ban} onClick={onVisitNotNeeded} disabled={savingNotNeeded}>
                    Visit not needed
                </Btn>
            )}
            {/* ID 83: the owner asks the NeoDove calling team to ring this dealer
                next. The call that follows is marked "called on your behalf". */}
            <CallNowButton
                leadId={lead.id}
                leadName={lead.shop_name || lead.dealer_name || "this lead"}
                disabled={!open}
                onQueued={onChanged}
            />
            <div className="ml-auto flex flex-wrap items-center gap-2">
                {isWon ? (
                    correctGstin
                ) : (
                    <Btn
                        tone="emerald"
                        icon={CheckCircle2}
                        onClick={() => onAction("mark_converted")}
                        disabled={!open}
                        disabledReason={
                            !open ? `Lead is ${status === "Lost" ? "Lost — reactivate it first" : "closed"}` : undefined
                        }
                    >
                        Mark Won
                    </Btn>
                )}
                {/* ID 115.4: a Won lead goes to Lost only through the admin
                    onboarding drop-out review — the server refuses it here. */}
                {status !== "Won" && (
                    <Btn tone="rose" icon={XCircle} onClick={() => onAction("mark_lost")}>
                        Mark Lost
                    </Btn>
                )}
                <LeadMoreMenu items={more} />
            </div>
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
