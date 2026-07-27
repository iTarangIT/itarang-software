"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import type { TranscriptTarget } from "./types";

type Message = {
    id: string;
    direction: "inbound" | "outbound";
    messageType: string;
    textBody: string | null;
    templateName: string | null;
    storagePath: string | null;
    deliveryStatus: string | null;
    createdAt: string;
};

function bodyOf(m: Message): string {
    if (m.textBody) return m.textBody;
    if (m.templateName) return `[template: ${m.templateName}]`;
    if (m.storagePath) return `[${m.messageType} attachment]`;
    return `[${m.messageType}]`;
}

export function TranscriptDrawer({
    target,
    onClose,
}: {
    target: TranscriptTarget;
    onClose: () => void;
}) {
    const query = useQuery<{
        success: true;
        data: { messages: Message[] };
    }>({
        queryKey: ["admin-whatsapp-transcript", target.sessionId],
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/whatsapp-operators/sessions/${target.sessionId}/messages`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load the conversation");
            return res.json();
        },
    });

    const messages = query.data?.data.messages ?? [];

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
            <div className="flex h-full w-full max-w-lg flex-col border-l border-border bg-surface shadow-xl">
                <div className="flex items-start gap-3 border-b border-border px-5 py-3">
                    <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-ink">
                            {target.title}
                        </h3>
                        <p className="truncate text-xs text-ink-muted">
                            {target.subtitle}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="ml-auto text-ink-muted hover:text-ink"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                    {query.isLoading && (
                        <div className="flex justify-center py-10 text-ink-muted">
                            <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                    )}
                    {query.isError && (
                        <div className="py-10 text-center text-sm text-danger">
                            Couldn&apos;t load this conversation.
                        </div>
                    )}
                    {!query.isLoading && messages.length === 0 && (
                        <div className="py-10 text-center text-sm text-ink-muted">
                            No messages logged for this conversation yet.
                        </div>
                    )}
                    {messages.map((m) => {
                        const outbound = m.direction === "outbound";
                        return (
                            <div
                                key={m.id}
                                className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                            >
                                <div
                                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                                        outbound
                                            ? "bg-primary/10 text-ink"
                                            : "bg-surface-muted text-ink"
                                    }`}
                                >
                                    {bodyOf(m)}
                                    <div className="mt-1 text-[10px] text-ink-muted">
                                        {new Date(m.createdAt).toLocaleString()}
                                        {outbound && m.deliveryStatus
                                            ? ` · ${m.deliveryStatus}`
                                            : ""}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="border-t border-border px-5 py-2.5 text-xs text-ink-muted">
                    Read-only. Passwords and OTPs are redacted before this
                    conversation leaves the server.
                </div>
            </div>
        </div>
    );
}
