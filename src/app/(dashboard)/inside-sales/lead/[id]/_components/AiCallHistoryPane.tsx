"use client";

/**
 * AI Call History for one dealer lead — the same per-attempt timeline the admin
 * sees in the campaign drawer, on the rep's and ASM's own lead page.
 *
 * The cards come straight from `AttemptsTab` in CampaignLeadTranscriptDrawer;
 * this file only fetches. Re-drawing those cards here would guarantee the two
 * views disagree about what an attempt looks like within a release or two.
 *
 * Reads /api/inside-sales/lead/[id]/ai-calls: every campaign attempt AND every
 * one-off Bolna / ElevenLabs call placed from the leads list, which belongs to
 * no campaign. It used to read the campaign transcript endpoint, so a lead that
 * was only ever called one-off showed "No AI calls yet".
 */
import { useQuery } from "@tanstack/react-query";
import { Loader2, PhoneCall, PhoneOff } from "lucide-react";

import { AttemptsTab } from "@/components/leads/CampaignLeadTranscriptDrawer";
import type { Attempt } from "@/components/leads/CampaignLeadTranscriptDrawer";
import { CALL_CATEGORY_LABELS, isCallCategory } from "@/lib/ai-dialer/callCategory";

type OpenCallback = {
    owner_type: "ai" | "sales";
    status: string;
    topic: string | null;
    category: string | null;
    requested_text: string | null;
    due_at: string;
    /** Server clock — keeps render pure. */
    overdue: boolean;
    attempts: number;
    summary: string | null;
};

/**
 * AI dialer review — the callback the dealer asked an AI call for, until a
 * person logs a conversation (sales) or the AI calls back (ai). Renders nothing
 * when there is none (or the database has no E-356).
 */
function CallbackCard({ leadId }: { leadId: string }) {
    const q = useQuery({
        queryKey: ["lead-ai-callback", leadId],
        staleTime: 30_000,
        queryFn: async () => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/callback`, {
                cache: "no-store",
            });
            const json = (await res.json()) as { data?: { callback: OpenCallback | null } };
            return json.data?.callback ?? null;
        },
    });
    const cb = q.data;
    if (!cb) return null;
    const due = new Date(cb.due_at);
    const overdue = cb.overdue;
    const sales = cb.owner_type === "sales";
    return (
        <div
            className={`mx-4 mt-4 rounded-xl border px-4 py-3 text-sm ${
                sales ? "border-orange-200 bg-orange-50" : "border-sky-200 bg-sky-50"
            }`}
        >
            <div className="flex items-center gap-2 font-semibold text-gray-900">
                <PhoneCall className="h-4 w-4" />
                {sales ? "Callback requested — for the sales team" : "Callback requested — the AI will call back"}
            </div>
            <p className={`mt-1 text-xs ${overdue ? "font-semibold text-rose-700" : "text-gray-700"}`}>
                Due{" "}
                {due.toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                })}
                {overdue && " · overdue"}
                {cb.requested_text && ` · dealer said “${cb.requested_text}”`}
            </p>
            <p className="mt-1 text-xs text-gray-600">
                {cb.category && isCallCategory(cb.category) ? CALL_CATEGORY_LABELS[cb.category] : "Callback"}
                {cb.topic && cb.topic !== "none" && ` · topic: ${cb.topic.replace(/_/g, " ")}`}
                {!sales && cb.attempts > 0 && ` · ${cb.attempts} AI attempt${cb.attempts === 1 ? "" : "s"}`}
            </p>
            {cb.summary && <p className="mt-1 text-xs text-gray-600">{cb.summary}</p>}
            {sales && (
                <p className="mt-1 text-[11px] text-gray-500">
                    Closes when a call, visit or WhatsApp chat with the dealer is logged.
                </p>
            )}
        </div>
    );
}

type TranscriptResponse = {
    success?: boolean;
    data?: {
        attempts: Attempt[] | null;
        convertedOnAttempt: number | null;
    };
    error?: { message?: string };
};

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center px-6 py-16 text-center">
            {children}
        </div>
    );
}

export function AiCallHistoryPane({ leadId }: { leadId: string }) {
    const query = useQuery({
        queryKey: ["lead-call-history", leadId],
        staleTime: 30_000,
        queryFn: async () => {
            const res = await fetch(
                `/api/inside-sales/lead/${encodeURIComponent(leadId)}/ai-calls`,
                { cache: "no-store" },
            );
            const json = (await res.json()) as TranscriptResponse;
            if (!res.ok || json.success === false) {
                throw new Error(json.error?.message ?? `HTTP ${res.status}`);
            }
            return json.data ?? { attempts: [], convertedOnAttempt: null };
        },
    });

    if (query.isLoading) {
        return (
            <Centered>
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </Centered>
        );
    }

    if (query.isSuccess && (query.data?.attempts ?? []).length === 0) {
        return (
            <Centered>
                <div>
                    <PhoneOff className="mx-auto h-8 w-8 text-gray-300" />
                    <p className="mt-3 text-sm font-medium text-gray-700">No AI calls yet</p>
                    <p className="mt-1 text-xs text-gray-500">
                        Campaign calls and single Bolna / ElevenLabs calls appear here once the
                        call has ended.
                    </p>
                </div>
            </Centered>
        );
    }

    if (query.isError) {
        return (
            <Centered>
                <p className="text-sm text-rose-600">
                    {query.error instanceof Error ? query.error.message : "Failed to load call history"}
                </p>
            </Centered>
        );
    }

    return (
        <div className="h-full overflow-y-auto">
            <CallbackCard leadId={leadId} />
            <AttemptsTab
                data={{
                    attempts: query.data?.attempts ?? [],
                    convertedOnAttempt: query.data?.convertedOnAttempt ?? null,
                }}
            />
        </div>
    );
}
