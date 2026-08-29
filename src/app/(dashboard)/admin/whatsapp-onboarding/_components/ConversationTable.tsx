"use client";

import { FileText, MessageSquare, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatWaPhone } from "@/lib/whatsapp/labels";
import { ActivityDot, ContactTypeBadge, StageBadge } from "./StageBadge";
import type { LiveConversation, TranscriptTarget } from "./types";

const CHANNEL_LABEL: Record<string, string> = {
    self: "Self-serve",
    operator: "Operator",
    operator_handoff: "Handed to dealer",
};

function relative(iso: string | null): string {
    if (!iso) return "Never replied";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "—";
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}

export function ConversationTable({
    conversations,
    loading,
    onOpenDetail,
    onOpenTranscript,
}: {
    conversations: LiveConversation[];
    loading: boolean;
    onOpenDetail: (c: LiveConversation) => void;
    onOpenTranscript: (t: TranscriptTarget) => void;
}) {
    if (loading) {
        return (
            <div className="px-4 py-10 text-center text-sm text-ink-muted">
                Loading conversations…
            </div>
        );
    }

    if (conversations.length === 0) {
        return (
            <div className="px-4 py-12 text-center">
                <p className="text-sm font-medium text-ink">
                    No WhatsApp conversations yet
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                    Anyone who messages the onboarding number appears here
                    immediately — even before they share a single document.
                </p>
            </div>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                        <th className="px-4 py-2.5 font-medium">Contact</th>
                        <th className="px-4 py-2.5 font-medium">Type</th>
                        <th className="px-4 py-2.5 font-medium">Stage</th>
                        <th className="px-4 py-2.5 font-medium">Documents</th>
                        <th className="px-4 py-2.5 font-medium">Channel</th>
                        <th className="px-4 py-2.5 font-medium">Last message</th>
                        <th className="px-4 py-2.5 font-medium text-right">
                            Actions
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {conversations.map((c) => {
                        const transcriptSessionId =
                            c.dealerSessionId ?? c.operatorSessionId;
                        return (
                            <tr
                                key={c.applicationId}
                                className="border-b border-border/60 last:border-0 hover:bg-surface-muted/50"
                            >
                                <td className="px-4 py-3 align-top">
                                    <button
                                        type="button"
                                        onClick={() => onOpenDetail(c)}
                                        className="text-left font-medium text-ink hover:underline"
                                    >
                                        {c.displayName}
                                    </button>
                                    <div className="mt-0.5 text-xs text-ink-muted">
                                        {formatWaPhone(c.waPhone)}
                                    </div>
                                    {!c.companyName && (
                                        <div className="mt-0.5 text-xs text-ink-muted italic">
                                            Business name not captured yet
                                        </div>
                                    )}
                                    {c.duplicateOnPhone && (
                                        <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                                            <Users className="h-3 w-3" />
                                            More than one file on this number
                                        </div>
                                    )}
                                </td>

                                <td className="px-4 py-3 align-top">
                                    <ContactTypeBadge
                                        type={c.contactType}
                                        label={c.contactTypeLabel}
                                    />
                                </td>

                                <td className="px-4 py-3 align-top">
                                    <StageBadge
                                        stage={c.stage}
                                        label={c.stageLabel}
                                    />
                                    <div className="mt-1">
                                        <ActivityDot activity={c.activity} />
                                    </div>
                                </td>

                                <td className="px-4 py-3 align-top">
                                    <span className="tabular-nums font-medium text-ink">
                                        {c.docsUploaded} / {c.docsRequired}
                                    </span>
                                    {c.missingDocuments.length > 0 && (
                                        <div
                                            className="mt-0.5 max-w-[220px] truncate text-xs text-ink-muted"
                                            title={c.missingDocuments
                                                .map((d) => d.label)
                                                .join(", ")}
                                        >
                                            Missing:{" "}
                                            {c.missingDocuments
                                                .map((d) => d.label)
                                                .join(", ")}
                                        </div>
                                    )}
                                    {c.warningCount > 0 && (
                                        <div className="mt-0.5 text-xs text-warning">
                                            {c.warningCount} check warning
                                            {c.warningCount === 1 ? "" : "s"}
                                        </div>
                                    )}
                                </td>

                                <td className="px-4 py-3 align-top">
                                    <div className="text-xs text-ink">
                                        {CHANNEL_LABEL[c.channel] ?? c.channel}
                                    </div>
                                    {c.operatorName && (
                                        <div className="mt-0.5 text-xs text-ink-muted">
                                            {c.operatorName}
                                        </div>
                                    )}
                                </td>

                                <td className="px-4 py-3 align-top">
                                    <div className="text-xs text-ink">
                                        {relative(c.lastInboundAt)}
                                    </div>
                                    <div className="mt-0.5 text-xs text-ink-muted">
                                        First contact{" "}
                                        {new Date(
                                            c.firstContactAt,
                                        ).toLocaleDateString()}
                                    </div>
                                </td>

                                <td className="px-4 py-3 align-top">
                                    <div className="flex justify-end gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => onOpenDetail(c)}
                                        >
                                            <FileText className="mr-1.5 h-3.5 w-3.5" />
                                            Details
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={!transcriptSessionId}
                                            onClick={() =>
                                                transcriptSessionId &&
                                                onOpenTranscript({
                                                    sessionId:
                                                        transcriptSessionId,
                                                    title: c.displayName,
                                                    subtitle: formatWaPhone(
                                                        c.waPhone,
                                                    ),
                                                })
                                            }
                                        >
                                            <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                                            Chat
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
