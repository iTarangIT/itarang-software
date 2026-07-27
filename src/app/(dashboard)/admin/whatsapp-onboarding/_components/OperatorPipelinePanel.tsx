"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MessageSquare, Send, KeyRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OperatorRow, PipelineFile, TranscriptTarget } from "./types";

const CHANNEL_LABEL: Record<string, string> = {
    self: "Dealer self-serve",
    operator: "Operator uploading",
    operator_handoff: "Handed to dealer",
};

function statusTone(status: string | null): string {
    switch (status) {
        case "approved":
            return "bg-success/10 text-success";
        case "submitted":
            return "bg-info/10 text-info";
        case "rejected":
            return "bg-danger/10 text-danger";
        default:
            return "bg-ink-muted/10 text-ink-muted";
    }
}

export function OperatorPipelinePanel({
    operator,
    canWrite,
    onClose,
    onOpenTranscript,
}: {
    operator: OperatorRow;
    canWrite: boolean;
    onClose: () => void;
    onOpenTranscript: (t: TranscriptTarget) => void;
}) {
    const [busy, setBusy] = useState<string | null>(null);

    const query = useQuery<{ success: true; data: { files: PipelineFile[] } }>({
        queryKey: ["admin-whatsapp-operator-pipeline", operator.id],
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/whatsapp-operators/${operator.id}/pipeline`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load the pipeline");
            return res.json();
        },
        refetchInterval: 60_000,
    });

    const files = query.data?.data.files ?? [];

    async function post(url: string, key: string, okMessage: string) {
        setBusy(key);
        try {
            const res = await fetch(url, { method: "POST" });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json?.error?.message || "Request failed");
            const delivered =
                json?.data?.delivered ?? json?.data?.whatsappDelivery?.ok;
            toast.success(
                delivered === false
                    ? `${okMessage} — but WhatsApp did not deliver (24h window closed). Email was still sent.`
                    : okMessage,
            );
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Request failed");
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <div>
                    <h2 className="text-sm font-semibold text-ink">
                        {operator.displayName}&apos;s dealers
                    </h2>
                    <p className="text-xs text-ink-muted">
                        +{operator.waPhone} · {operator.counts.total} file
                        {operator.counts.total === 1 ? "" : "s"}
                    </p>
                </div>
                {query.isFetching && (
                    <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
                )}
                <button
                    onClick={onClose}
                    className="ml-auto text-ink-muted hover:text-ink"
                    aria-label="Close"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            {query.isLoading ? (
                <div className="flex justify-center px-4 py-10 text-ink-muted">
                    <Loader2 className="h-5 w-5 animate-spin" />
                </div>
            ) : files.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-ink-muted">
                    This operator hasn&apos;t started any dealer files yet.
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                                <th className="px-4 py-2 font-medium">Dealer</th>
                                <th className="px-4 py-2 font-medium">
                                    Dealer WhatsApp
                                </th>
                                <th className="px-4 py-2 font-medium">Channel</th>
                                <th className="px-4 py-2 font-medium">Status</th>
                                <th className="px-4 py-2 font-medium">
                                    Conversation
                                </th>
                                <th className="px-4 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {files.map((f) => {
                                const name =
                                    f.companyName ||
                                    f.ownerName ||
                                    f.dealerPhone ||
                                    "Unnamed dealer";
                                return (
                                    <tr
                                        key={f.applicationId}
                                        className="border-b border-border last:border-0"
                                    >
                                        <td className="px-4 py-2.5">
                                            <div className="font-medium text-ink">
                                                {name}
                                            </div>
                                            {f.dealerCode && (
                                                <div className="font-mono text-xs text-ink-muted">
                                                    {f.dealerCode}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-xs">
                                            {f.dealerPhone
                                                ? `+${f.dealerPhone}`
                                                : "—"}
                                        </td>
                                        <td className="px-4 py-2.5 text-xs">
                                            {CHANNEL_LABEL[f.channel ?? "self"] ??
                                                f.channel}
                                        </td>
                                        <td className="px-4 py-2.5">
                                            <span
                                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(
                                                    f.onboardingStatus,
                                                )}`}
                                            >
                                                {f.onboardingStatus ?? "—"}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2.5">
                                            <div className="flex flex-wrap gap-1.5">
                                                {f.operatorSessionId && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() =>
                                                            onOpenTranscript({
                                                                sessionId:
                                                                    f.operatorSessionId!,
                                                                title: `${name} — operator chat`,
                                                                subtitle: `${operator.displayName} · ${f.operatorState ?? ""}`,
                                                            })
                                                        }
                                                    >
                                                        <MessageSquare className="mr-1 h-3.5 w-3.5" />
                                                        Operator
                                                    </Button>
                                                )}
                                                {f.dealerSessionId && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() =>
                                                            onOpenTranscript({
                                                                sessionId:
                                                                    f.dealerSessionId!,
                                                                title: `${name} — dealer chat`,
                                                                subtitle: `+${f.dealerPhone ?? ""} · ${f.dealerState ?? ""}`,
                                                            })
                                                        }
                                                    >
                                                        <MessageSquare className="mr-1 h-3.5 w-3.5" />
                                                        Dealer
                                                    </Button>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5 text-right">
                                            {canWrite && (
                                                <div className="flex justify-end gap-1.5">
                                                    {f.onboardingStatus !==
                                                        "approved" &&
                                                        f.dealerPhone && (
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                disabled={
                                                                    busy ===
                                                                    `invite-${f.applicationId}`
                                                                }
                                                                onClick={() =>
                                                                    post(
                                                                        `/api/admin/whatsapp-operators/applications/${f.applicationId}/resend-invite`,
                                                                        `invite-${f.applicationId}`,
                                                                        "Invite re-sent to the dealer",
                                                                    )
                                                                }
                                                                title="Re-send the dealer's WhatsApp invite"
                                                            >
                                                                {busy ===
                                                                `invite-${f.applicationId}` ? (
                                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                ) : (
                                                                    <>
                                                                        <Send className="mr-1 h-3.5 w-3.5" />
                                                                        Invite
                                                                    </>
                                                                )}
                                                            </Button>
                                                        )}
                                                    {f.onboardingStatus ===
                                                        "approved" && (
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={
                                                                busy ===
                                                                `creds-${f.applicationId}`
                                                            }
                                                            onClick={() => {
                                                                if (
                                                                    !window.confirm(
                                                                        `Reset ${name}'s password and send new credentials?\n\nThe current password will stop working immediately.`,
                                                                    )
                                                                )
                                                                    return;
                                                                post(
                                                                    `/api/admin/whatsapp-operators/applications/${f.applicationId}/resend-credentials`,
                                                                    `creds-${f.applicationId}`,
                                                                    "New credentials issued and sent",
                                                                );
                                                            }}
                                                            title="Mint a new temporary password and send it by email + WhatsApp"
                                                        >
                                                            {busy ===
                                                            `creds-${f.applicationId}` ? (
                                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                            ) : (
                                                                <>
                                                                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                                                                    Reset &amp;
                                                                    resend
                                                                </>
                                                            )}
                                                        </Button>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
