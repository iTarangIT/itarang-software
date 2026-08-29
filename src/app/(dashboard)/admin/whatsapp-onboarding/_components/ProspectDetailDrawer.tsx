"use client";

import { useQuery } from "@tanstack/react-query";
import {
    Check,
    ExternalLink,
    Loader2,
    MessageSquare,
    X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatWaPhone } from "@/lib/whatsapp/labels";
import { ContactTypeBadge, StageBadge } from "./StageBadge";
import type { ConversationDetail, TranscriptTarget } from "./types";

const SOURCE_LABEL: Record<string, string> = {
    application: "Verified field",
    chat_answer: "Answered in chat",
    document: "Read from document",
};

export function ProspectDetailDrawer({
    applicationId,
    title,
    onClose,
    onOpenTranscript,
}: {
    applicationId: string;
    title: string;
    onClose: () => void;
    onOpenTranscript: (t: TranscriptTarget) => void;
}) {
    const query = useQuery<{ success: true; data: ConversationDetail }>({
        queryKey: ["admin-whatsapp-conversation", applicationId],
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/whatsapp-onboarding/conversations/${applicationId}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load this conversation");
            return res.json();
        },
        refetchInterval: 60_000,
    });

    const detail = query.data?.data;

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
            <div className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-surface shadow-xl">
                <div className="flex items-start gap-3 border-b border-border px-5 py-3">
                    <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-ink">
                            {detail?.application.displayName ?? title}
                        </h3>
                        <p className="truncate text-xs text-ink-muted">
                            {formatWaPhone(detail?.application.waPhone ?? null)}
                            {detail?.application.operator
                                ? ` · via ${detail.application.operator.displayName}`
                                : ""}
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

                <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
                    {query.isLoading && (
                        <div className="flex justify-center py-12 text-ink-muted">
                            <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                    )}
                    {query.isError && (
                        <div className="py-12 text-center text-sm text-danger">
                            Couldn&apos;t load this conversation.
                        </div>
                    )}

                    {detail && (
                        <>
                            <section className="flex flex-wrap items-center gap-2">
                                <ContactTypeBadge
                                    type={detail.application.contactType}
                                    label={detail.application.contactTypeLabel}
                                />
                                <StageBadge
                                    stage={detail.application.stage}
                                    label={detail.application.stageLabel}
                                />
                                <span className="text-xs text-ink-muted">
                                    {detail.progress.docsUploaded} of{" "}
                                    {detail.progress.docsRequired} documents ·{" "}
                                    {detail.captured.length} details captured
                                </span>
                                <div className="ml-auto flex gap-2">
                                    {detail.sessions.map((s) => (
                                        <Button
                                            key={s.id}
                                            variant="outline"
                                            size="sm"
                                            onClick={() =>
                                                onOpenTranscript({
                                                    sessionId: s.id,
                                                    title: detail.application
                                                        .displayName,
                                                    subtitle: `${
                                                        s.role === "operator"
                                                            ? "Operator chat"
                                                            : "Dealer chat"
                                                    } · ${formatWaPhone(s.waPhone)}`,
                                                })
                                            }
                                        >
                                            <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                                            {s.role === "operator"
                                                ? "Operator chat"
                                                : "Chat"}
                                        </Button>
                                    ))}
                                </div>
                            </section>

                            <section>
                                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                                    Details captured so far
                                </h4>
                                {detail.captured.length === 0 ? (
                                    <p className="rounded-lg border border-border bg-surface-muted px-3 py-3 text-sm text-ink-muted">
                                        Nothing beyond the phone number yet —
                                        this contact has only opened the chat.
                                    </p>
                                ) : (
                                    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                                        {detail.captured.map((f) => (
                                            <div key={f.key}>
                                                <dt className="text-xs text-ink-muted">
                                                    {f.label}
                                                    <span
                                                        className="ml-1 opacity-60"
                                                        title={
                                                            SOURCE_LABEL[
                                                                f.source
                                                            ] ?? f.source
                                                        }
                                                    >
                                                        ·{" "}
                                                        {f.source === "document"
                                                            ? f.docType
                                                            : SOURCE_LABEL[
                                                                  f.source
                                                              ]}
                                                    </span>
                                                </dt>
                                                <dd className="text-sm text-ink break-words">
                                                    {f.value}
                                                </dd>
                                            </div>
                                        ))}
                                    </dl>
                                )}
                            </section>

                            <section>
                                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                                    Documents received ({detail.documents.length})
                                </h4>
                                {detail.documents.length === 0 ? (
                                    <p className="rounded-lg border border-border bg-surface-muted px-3 py-3 text-sm text-ink-muted">
                                        No documents uploaded yet.
                                    </p>
                                ) : (
                                    <div className="space-y-2">
                                        {detail.documents.map((d) => (
                                            <div
                                                key={d.id}
                                                className="rounded-lg border border-border bg-surface px-3 py-2.5"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium text-ink">
                                                        {d.label}
                                                    </span>
                                                    {d.verificationStatus && (
                                                        <span className="rounded-full bg-ink-muted/10 px-2 py-0.5 text-[10px] text-ink-muted">
                                                            {d.verificationStatus}
                                                        </span>
                                                    )}
                                                    {d.fileUrl && (
                                                        <a
                                                            href={d.fileUrl}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                                        >
                                                            <ExternalLink className="h-3.5 w-3.5" />
                                                            Open
                                                        </a>
                                                    )}
                                                </div>
                                                <div className="mt-0.5 text-xs text-ink-muted">
                                                    {new Date(
                                                        d.uploadedAt,
                                                    ).toLocaleString()}
                                                    {d.extractionConfidence
                                                        ? ` · confidence ${d.extractionConfidence}`
                                                        : ""}
                                                </div>
                                                {Object.keys(d.extractedFields)
                                                    .length > 0 && (
                                                    <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 border-t border-border pt-2 sm:grid-cols-2">
                                                        {Object.entries(
                                                            d.extractedFields,
                                                        )
                                                            .filter(
                                                                ([, v]) =>
                                                                    v != null &&
                                                                    v !== "",
                                                            )
                                                            .map(([k, v]) => (
                                                                <div key={k}>
                                                                    <span className="text-xs text-ink-muted">
                                                                        {k.replaceAll(
                                                                            "_",
                                                                            " ",
                                                                        )}
                                                                        :{" "}
                                                                    </span>
                                                                    <span className="text-xs text-ink break-words">
                                                                        {typeof v ===
                                                                        "object"
                                                                            ? JSON.stringify(
                                                                                  v,
                                                                              )
                                                                            : String(
                                                                                  v,
                                                                              )}
                                                                    </span>
                                                                </div>
                                                            ))}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </section>

                            <section>
                                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                                    Checklist
                                </h4>
                                <ul className="space-y-1">
                                    {detail.checklist.map((c) => (
                                        <li
                                            key={c.type}
                                            className="flex items-center gap-2 text-sm"
                                        >
                                            {c.uploaded ? (
                                                <Check className="h-3.5 w-3.5 text-success" />
                                            ) : (
                                                <span className="h-3.5 w-3.5 rounded-full border border-border" />
                                            )}
                                            <span
                                                className={
                                                    c.uploaded
                                                        ? "text-ink"
                                                        : "text-ink-muted"
                                                }
                                            >
                                                {c.label}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                                {detail.skipped.length > 0 && (
                                    <p className="mt-2 text-xs text-warning">
                                        Skipped in chat:{" "}
                                        {detail.skipped
                                            .map((s) => s.label)
                                            .join(", ")}
                                    </p>
                                )}
                            </section>

                            {/* Only once submitted — before that the review page
                                can't action anything, which is the whole reason
                                this console exists. */}
                            {detail.application.submittedAt && (
                                <section>
                                    <a
                                        href={`/admin/dealer-verification/${detail.application.applicationId}`}
                                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                                    >
                                        <ExternalLink className="h-3.5 w-3.5" />
                                        Open the full dealer review page
                                    </a>
                                </section>
                            )}
                        </>
                    )}
                </div>

                <div className="border-t border-border px-5 py-2.5 text-xs text-ink-muted">
                    Read-only. Everything here is captured as the conversation
                    happens — no Submit required.
                </div>
            </div>
        </div>
    );
}
