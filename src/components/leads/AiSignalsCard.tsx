"use client";

// AiSignalsPanel, fetching its own data for one lead.
//
// A thin wrapper so the two lead-detail screens can drop in one component
// without either of them learning the response shape. Both read the SAME
// lead-scoped route the AI-connected block's notice uses, so a lead can never
// show one thing on the panel and another in the block.
//
// Renders nothing at all when the AI has never called the lead — which is ~97%
// of them. An empty "what the AI learned" box on every lead is noise.

import { useQuery } from "@tanstack/react-query";
import { AiSignalsPanel, type AiSignalsData } from "./AiSignalsPanel";

type AiSummary = {
  hasAiCall: boolean;
  connected: boolean;
  latest: {
    band: string | null;
    callStatus: string | null;
    infoSignalsCount: number | null;
    scoreBreakdown: unknown;
    intentScore: number | null;
    summary: string | null;
    calledAt: string | null;
    recordingUrl: string | null;
    callDuration: number | null;
  } | null;
};

export function AiSignalsCard({ leadId }: { leadId: string }) {
  const { data } = useQuery<AiSummary | null>({
    queryKey: ["lead-ai-summary", leadId],
    enabled: Boolean(leadId),
    // The AI dialer is not live-updating this page; a stale read for a minute
    // is fine and keeps this off the hot path of every lead open.
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/dealer-leads/${leadId}/ai-summary`);
      const json = await res.json();
      return json?.success ? (json.data as AiSummary) : null;
    },
  });

  if (!data?.hasAiCall || !data.latest) return null;

  const d: AiSignalsData = {
    band: data.latest.band,
    callStatus: data.latest.callStatus,
    infoSignalsCount: data.latest.infoSignalsCount,
    scoreBreakdown: data.latest.scoreBreakdown as AiSignalsData["scoreBreakdown"],
    intentScore: data.latest.intentScore,
    summary: data.latest.summary,
    calledAt: data.latest.calledAt,
    connected: data.connected,
    recordingUrl: data.latest.recordingUrl,
    callDuration: data.latest.callDuration,
  };

  return <AiSignalsPanel data={d} variant="panel" />;
}
