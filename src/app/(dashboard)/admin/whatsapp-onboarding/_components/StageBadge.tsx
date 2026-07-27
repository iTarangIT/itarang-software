"use client";

import { cn } from "@/lib/utils";
import {
    ACTIVITY_LABEL,
    STAGE_TONE,
    type ContactType,
    type StageTone,
    type WaActivity,
    type WaStage,
} from "@/lib/whatsapp/stage";

const TONE_CLASS: Record<StageTone, string> = {
    neutral: "bg-ink-muted/10 text-ink-muted",
    info: "bg-info/10 text-info",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
};

export function StageBadge({
    stage,
    label,
    className,
}: {
    stage: WaStage;
    label: string;
    className?: string;
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                TONE_CLASS[STAGE_TONE[stage] ?? "neutral"],
                className,
            )}
        >
            {label}
        </span>
    );
}

// Deliberately a different visual family from the stage badge (outlined, not
// filled) so "who is this" never reads as "where are they in the flow".
const CONTACT_TYPE_CLASS: Record<ContactType, string> = {
    dealer: "border-brand-sky/40 text-brand-navy bg-brand-sky/5",
    customer: "border-info/40 text-info bg-info/5",
    enquiry: "border-border text-ink-muted bg-transparent",
    undecided: "border-dashed border-border text-ink-muted bg-transparent",
};

export function ContactTypeBadge({
    type,
    label,
}: {
    type: ContactType;
    label: string;
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
                CONTACT_TYPE_CLASS[type] ?? CONTACT_TYPE_CLASS.undecided,
            )}
        >
            {label}
        </span>
    );
}

const ACTIVITY_DOT: Record<WaActivity, string> = {
    live: "bg-success",
    recent: "bg-warning",
    stale: "bg-ink-muted/50",
};

/** A contact who messaged once and vanished is labelled, never hidden. */
export function ActivityDot({ activity }: { activity: WaActivity }) {
    return (
        <span
            className="inline-flex items-center gap-1.5 text-xs text-ink-muted"
            title={ACTIVITY_LABEL[activity]}
        >
            <span
                className={cn("h-1.5 w-1.5 rounded-full", ACTIVITY_DOT[activity])}
            />
            {ACTIVITY_LABEL[activity]}
        </span>
    );
}
