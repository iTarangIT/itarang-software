"use client";

/**
 * AI Call History for one dealer lead — the same per-attempt timeline the admin
 * sees in the campaign drawer, on the rep's and ASM's own lead page.
 *
 * The cards come straight from `AttemptsTab` in CampaignLeadTranscriptDrawer;
 * this file only fetches. Re-drawing those cards here would guarantee the two
 * views disagree about what an attempt looks like within a release or two.
 *
 * WHY THIS TAKES A campaignId FOR A PER-LEAD VIEW: the transcript endpoint is
 * routed under a campaign, but it answers with every attempt across ALL
 * campaigns the lead has ever been in (it resolves the lead's full campaign set
 * server-side). So any one of the lead's campaign ids yields the same list, and
 * the lead detail API hands us the newest. No campaign at all means the lead was
 * never dialled — the empty state below, not an error.
 */
import { useQuery } from "@tanstack/react-query";
import { Loader2, PhoneOff } from "lucide-react";

import { AttemptsTab } from "@/components/leads/CampaignLeadTranscriptDrawer";
import type { Attempt } from "@/components/leads/CampaignLeadTranscriptDrawer";

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

export function AiCallHistoryPane({
    leadId,
    campaignId,
}: {
    leadId: string;
    /** Newest campaign this lead was dialled in; null if it never was. */
    campaignId: string | null;
}) {
    const query = useQuery({
        queryKey: ["lead-call-history", leadId, campaignId],
        enabled: Boolean(campaignId),
        staleTime: 30_000,
        queryFn: async () => {
            const res = await fetch(
                `/api/ai-dialer/campaigns/${encodeURIComponent(campaignId as string)}/leads/${encodeURIComponent(leadId)}/transcript`,
                { cache: "no-store" },
            );
            const json = (await res.json()) as TranscriptResponse;
            if (!res.ok || json.success === false) {
                throw new Error(json.error?.message ?? `HTTP ${res.status}`);
            }
            return json.data ?? { attempts: [], convertedOnAttempt: null };
        },
    });

    if (!campaignId) {
        return (
            <Centered>
                <div>
                    <PhoneOff className="mx-auto h-8 w-8 text-gray-300" />
                    <p className="mt-3 text-sm font-medium text-gray-700">No AI calls yet</p>
                    <p className="mt-1 text-xs text-gray-500">
                        This lead has not been included in a dialer campaign. Attempts appear here
                        once it is called.
                    </p>
                </div>
            </Centered>
        );
    }

    if (query.isLoading) {
        return (
            <Centered>
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
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
            <AttemptsTab
                data={{
                    attempts: query.data?.attempts ?? [],
                    convertedOnAttempt: query.data?.convertedOnAttempt ?? null,
                }}
            />
        </div>
    );
}
