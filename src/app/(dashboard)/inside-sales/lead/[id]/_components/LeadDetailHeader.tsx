"use client";

import Link from "next/link";
import { ArrowLeft, Phone, MapPin, AlarmCheck, AlertCircle, RotateCcw, ShieldAlert, CheckCircle2 } from "lucide-react";
import type { LeadDetailBundle } from "@/lib/inside-sales/types";
import { IntentBadge } from "../../../_components/IntentBadge";
import { InterestLevelEditor } from "../../../_components/InterestLevelEditor";
import { LeadStatusEditor, type StatusModalAction } from "../../../_components/LeadStatusEditor";
import { OwnerIndicator } from "../../../_components/OwnerIndicator";

// Roles permitted to override a lead's temperature (mirrors the PATCH route).
const INTEREST_EDIT_ROLES = ["inside_sales_rep", "asm", "admin"];

type Props = {
    bundle: LeadDetailBundle;
    viewerId: string;
    viewerRole?: string;
    onUpdated?: () => void;
    // Dedicated-flow modals the parent view can open from the status editor.
    statusModalActions?: StatusModalAction[];
    onStatusModal?: (action: StatusModalAction) => void;
};

function daysAgo(iso: string | null): string {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function formatDateTime(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Short, human-friendly application reference (BRD §0.13 "Application ID: APP-XXXX").
function shortAppId(id: string | null): string {
    if (!id) return "—";
    return `APP-${id.slice(0, 8).toUpperCase()}`;
}

function formatOnboardingStatus(s: string | null): string {
    if (!s) return "Draft";
    return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

export function LeadDetailHeader({
    bundle,
    viewerId,
    viewerRole,
    onUpdated,
    statusModalActions,
    onStatusModal,
}: Props) {
    const lead = bundle.lead;
    const canEditInterest = INTEREST_EDIT_ROLES.includes(viewerRole ?? "");
    const isOwner = lead.current_owner_id === viewerId;
    const isUnassigned = !lead.current_owner_id;
    const isEscalated = lead.escalation_status === "pending_review";
    const wasReactivated = Boolean(lead.previous_lost_reason);
    const onboardingInitiated =
        lead.lead_status === "Converted" &&
        Boolean(lead.dealer_onboarding_application_id);

    return (
        <div className="border-b border-gray-200 bg-white sticky top-0 z-10">
            <div className="px-6 py-4 flex items-start justify-between gap-6">
                <div className="min-w-0 flex-1">
                    <Link href="/inside-sales" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-2">
                        <ArrowLeft className="h-3 w-3" />
                        Back to queue
                    </Link>
                    <div className="flex items-center gap-3 flex-wrap">
                        <h1 className="text-xl font-semibold text-gray-900 truncate">
                            {lead.dealer_name || lead.shop_name || "(unnamed dealer)"}
                        </h1>
                        <LeadStatusEditor
                            leadId={lead.id}
                            status={lead.lead_status}
                            editable={isOwner}
                            modalActions={statusModalActions}
                            onModalAction={onStatusModal}
                            onUpdated={onUpdated}
                        />
                        <InterestLevelEditor
                            leadId={lead.id}
                            value={lead.interest_level}
                            editable={canEditInterest}
                            onUpdated={onUpdated}
                        />
                        <IntentBadge score={lead.final_intent_score} />
                    </div>
                    {lead.shop_name && lead.dealer_name && (
                        <div className="text-xs text-gray-500 mt-0.5">{lead.shop_name}</div>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-600 flex-wrap">
                        <span className="inline-flex items-center gap-1">
                            <Phone className="h-3 w-3 text-gray-400" />
                            {lead.phone || "—"}
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-gray-400" />
                            {[lead.city, lead.state].filter(Boolean).join(", ") || "—"}
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <AlarmCheck className="h-3 w-3 text-gray-400" />
                            Last touch: {daysAgo(lead.last_touchpoint_at)}
                        </span>
                        <OwnerIndicator
                            currentOwnerId={lead.current_owner_id}
                            currentOwnerName={lead.current_owner_name}
                            viewerId={viewerId}
                            asmName={lead.asm_name}
                        />
                    </div>
                </div>
            </div>

            {/* Conditional banners (BRD §0.5) */}
            <div className="px-6 pb-3 space-y-2">
                {!isOwner && !isUnassigned && (
                    <Banner tone="gray" icon={ShieldAlert}>
                        You are not the current owner — view only.
                    </Banner>
                )}
                {isEscalated && (
                    <Banner tone="amber" icon={AlertCircle}>
                        Escalated — pending admin review.
                    </Banner>
                )}
                {wasReactivated && (
                    <Banner tone="sky" icon={RotateCcw}>
                        Reactivated from Lost{lead.previous_lost_reason ? ` (was ${lead.previous_lost_reason})` : ""}. Review prior history before calling.
                    </Banner>
                )}
                {onboardingInitiated && (
                    <Banner tone="emerald" icon={CheckCircle2}>
                        <span className="font-medium">Onboarding Initiated</span>
                        {" — Application "}
                        <span className="font-medium">{shortAppId(lead.dealer_onboarding_application_id)}</span>
                        {" · Status: "}
                        {formatOnboardingStatus(lead.onboarding_status)}
                        {lead.onboarding_created_at
                            ? ` · Created ${formatDateTime(lead.onboarding_created_at)}`
                            : ""}
                        {" · "}
                        <Link
                            href={`/dealer-onboarding?applicationId=${lead.dealer_onboarding_application_id}`}
                            className="font-semibold underline underline-offset-2 hover:text-emerald-900"
                        >
                            Continue Onboarding →
                        </Link>
                    </Banner>
                )}
            </div>
        </div>
    );
}

function Banner({
    children,
    icon: Icon,
    tone,
}: {
    children: React.ReactNode;
    icon: React.ComponentType<{ className?: string }>;
    tone: "gray" | "amber" | "sky" | "emerald";
}) {
    const tones: Record<string, string> = {
        gray: "border-gray-200 bg-gray-50 text-gray-700",
        amber: "border-amber-200 bg-amber-50 text-amber-800",
        sky: "border-sky-200 bg-sky-50 text-sky-800",
        emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    };
    return (
        <div className={`rounded-md border px-3 py-2 text-xs flex items-center gap-2 ${tones[tone]}`}>
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{children}</span>
        </div>
    );
}
