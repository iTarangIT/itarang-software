"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    CONTACT_TYPE_LABEL,
    STAGE_LABEL,
    type ContactType,
    type WaStage,
} from "@/lib/whatsapp/stage";
import { ConversationTable } from "./ConversationTable";
import { ProspectDetailDrawer } from "./ProspectDetailDrawer";
import { TranscriptDrawer } from "./TranscriptDrawer";
import type {
    ConversationSummary,
    LiveConversation,
    TranscriptTarget,
} from "./types";

// Stages worth filtering by, in flow order. Terminal ones are included so an
// admin can pull up "everything that got rejected" without leaving the page.
const FILTER_STAGES: WaStage[] = [
    "new_enquiry",
    "choosing_path",
    "general_enquiry",
    "identifying",
    "collecting_docs",
    "answering_fields",
    "confirming",
    "submitted",
    "correction",
    "rejected",
];

const FILTER_TYPES: ContactType[] = [
    "dealer",
    "customer",
    "enquiry",
    "undecided",
];

type Response = {
    success: true;
    data: {
        conversations: LiveConversation[];
        total: number;
        page: number;
        limit: number;
        summary: ConversationSummary;
    };
};

export function LiveConversationsView({
    onSummary,
}: {
    onSummary?: (s: ConversationSummary) => void;
}) {
    const qc = useQueryClient();
    const [search, setSearch] = useState("");
    const [applied, setApplied] = useState("");
    const [stage, setStage] = useState<string>("");
    const [type, setType] = useState<string>("");
    const [approvedOnly, setApprovedOnly] = useState(false);
    const [page, setPage] = useState(1);

    const [detail, setDetail] = useState<LiveConversation | null>(null);
    const [transcript, setTranscript] = useState<TranscriptTarget | null>(null);

    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (applied) params.set("q", applied);
    if (stage) params.set("stage", stage);
    if (type) params.set("type", type);
    if (approvedOnly) params.set("approvedOnly", "1");

    const query = useQuery<Response>({
        queryKey: ["admin-whatsapp-conversations", params.toString()],
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/whatsapp-onboarding/conversations?${params.toString()}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load conversations");
            const json = (await res.json()) as Response;
            onSummary?.(json.data.summary);
            return json;
        },
        refetchInterval: 60_000,
    });

    const conversations = query.data?.data.conversations ?? [];
    const total = query.data?.data.total ?? 0;
    const summary = query.data?.data.summary;
    const pages = Math.max(1, Math.ceil(total / 25));

    const refresh = () =>
        qc.invalidateQueries({ queryKey: ["admin-whatsapp-conversations"] });

    return (
        <div className="space-y-4">
            {summary && (
                <div className="flex flex-wrap gap-3">
                    <Stat label="Total contacts" value={summary.total} />
                    <Stat label="Dealers" value={summary.byType?.dealer ?? 0} />
                    <Stat
                        label="Customers"
                        value={summary.byType?.customer ?? 0}
                    />
                    <Stat label="Still in progress" value={summary.inProgress} />
                    <Stat
                        label="Only said hi"
                        value={summary.byStage.new_enquiry ?? 0}
                    />
                    <Stat
                        label="Uploading documents"
                        value={summary.byStage.collecting_docs ?? 0}
                    />
                </div>
            )}

            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                    <form
                        className="relative"
                        onSubmit={(e) => {
                            e.preventDefault();
                            setPage(1);
                            setApplied(search.trim());
                        }}
                    >
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search name, phone, GST…"
                            className="h-8 w-56 rounded-md border border-border bg-bg pl-8 pr-2 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-brand-sky"
                        />
                    </form>

                    <select
                        value={type}
                        onChange={(e) => {
                            setPage(1);
                            setType(e.target.value);
                        }}
                        className="h-8 rounded-md border border-border bg-bg px-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-brand-sky"
                    >
                        <option value="">Dealers &amp; customers</option>
                        {FILTER_TYPES.map((t) => (
                            <option key={t} value={t}>
                                {CONTACT_TYPE_LABEL[t]}
                                {summary?.byType?.[t] != null
                                    ? ` (${summary.byType[t]})`
                                    : ""}
                            </option>
                        ))}
                    </select>

                    <select
                        value={stage}
                        onChange={(e) => {
                            setPage(1);
                            setStage(e.target.value);
                        }}
                        className="h-8 rounded-md border border-border bg-bg px-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-brand-sky"
                    >
                        <option value="">All stages</option>
                        {FILTER_STAGES.map((s) => (
                            <option key={s} value={s}>
                                {STAGE_LABEL[s]}
                            </option>
                        ))}
                    </select>

                    <label
                        className="flex items-center gap-1.5 text-xs text-ink-muted"
                        title="Show only dealers who have already been approved"
                    >
                        <input
                            type="checkbox"
                            checked={approvedOnly}
                            onChange={(e) => {
                                setPage(1);
                                setApprovedOnly(e.target.checked);
                            }}
                            className="h-3.5 w-3.5 rounded border-border"
                        />
                        Approved dealers only
                    </label>

                    {query.isFetching && (
                        <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
                    )}

                    <div className="ml-auto flex items-center gap-2">
                        <span className="text-xs text-ink-muted tabular-nums">
                            {total} contact{total === 1 ? "" : "s"}
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={refresh}
                            title="Refresh"
                        >
                            <RefreshCw className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                {query.isError ? (
                    <div className="px-4 py-8 text-sm text-danger">
                        Couldn&apos;t load WhatsApp conversations.
                    </div>
                ) : (
                    <ConversationTable
                        conversations={conversations}
                        loading={query.isLoading}
                        onOpenDetail={setDetail}
                        onOpenTranscript={setTranscript}
                    />
                )}

                {pages > 1 && (
                    <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
                        <span className="text-xs text-ink-muted">
                            Page {page} of {pages}
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page <= 1}
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                        >
                            Previous
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page >= pages}
                            onClick={() => setPage((p) => p + 1)}
                        >
                            Next
                        </Button>
                    </div>
                )}
            </div>

            {detail && (
                <ProspectDetailDrawer
                    applicationId={detail.applicationId}
                    title={detail.displayName}
                    onClose={() => setDetail(null)}
                    onOpenTranscript={setTranscript}
                />
            )}

            {transcript && (
                <TranscriptDrawer
                    target={transcript}
                    onClose={() => setTranscript(null)}
                />
            )}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-xl border border-border bg-surface px-4 py-2.5 shadow-card">
            <div className="text-xs text-ink-muted">{label}</div>
            <div className="text-lg font-semibold tabular-nums text-ink">
                {value}
            </div>
        </div>
    );
}
