"use client";

// The intent review surface on the lead-detail screens.
//
// This is where the loop the brief describes actually happens:
//
//   AI call → transcript + band → lead opens in the CRM → reviewer reads the
//   transcript, plays or attaches the recording, corrects the band, saves →
//   the lead moves AND the correction becomes training data.
//
// Before this, the lead-detail screens rendered AiSignalsCard: a read-only
// "what the AI learned" box. The only place to CORRECT anything was the
// campaign transcript drawer, which sales_head and sales_insight cannot reach
// at all (they have no campaign route) and which is an odd place to work
// anyway — people work on the lead, not on the campaign that dialled it.
//
// It replaces AiSignalsCard at both mount points and keeps that component's
// two hard-won behaviours:
//   · it fetches its own data, so neither host learns the response shape;
//   · it renders the SAME AiSignalsPanel the campaign drawer renders, so the
//     two views cannot drift.
//
// What it deliberately changes: AiSignalsCard rendered NOTHING when the AI had
// never called the lead. That was right for a read-only panel — an empty box on
// ~97% of leads is noise — but wrong now, because attaching your own recording
// is exactly the thing you want to do on a lead the dialer never reached. So
// with no AI call it collapses to the attach control alone, and only for people
// who may review.

import { useQuery } from "@tanstack/react-query";
import { UserCheck } from "lucide-react";

import { capabilitiesFor } from "@/lib/leads/access";
import { AiSignalsPanel, type AiSignalsData } from "../AiSignalsPanel";
import { AttachedRecordings } from "./AttachedRecordings";
import { CallTranscript } from "./CallTranscript";
import { CorrectIntentForm, type ClientSignals } from "./CorrectIntentForm";

type AiSummary = {
  hasAiCall: boolean;
  connected: boolean;
  latest: {
    callId: string | null;
    band: string | null;
    callStatus: string | null;
    infoSignalsCount: number | null;
    scoreBreakdown: unknown;
    signals: unknown;
    intentScore: number | null;
    summary: string | null;
    calledAt: string | null;
    recordingUrl: string | null;
    callDuration: number | null;
  } | null;
  provenance?: {
    source: "ai" | "human";
    overriddenByName: string | null;
    overriddenAt: string | null;
  } | null;
};

export function IntentReviewCard({ leadId }: { leadId: string }) {
  // Resolve the viewer's own capability rather than taking it as a prop. Both
  // hosts are deep in their own trees and neither has the role to hand, so a
  // prop would mean threading it through — or, more likely, each host growing
  // its own copy of this fetch. Shared query key, so the two lead-detail
  // screens and anything else on the page pay for it once.
  //
  // This is a UI hint ONLY: it decides whether to render controls the API
  // would refuse anyway. The real gate is requireRole(INTENT_REVIEW_ROLES) on
  // every write route. Defaults to all-false so a failed fetch hides actions
  // rather than showing ones that 403.
  const { data: role } = useQuery<string | null>({
    queryKey: ["user-profile-role"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch("/api/user/profile");
      const json = await res.json();
      return (json?.data?.role as string | undefined) ?? null;
    },
  });
  const canReview = capabilitiesFor(role ?? null).canReviewIntent;

  const { data } = useQuery<AiSummary | null>({
    queryKey: ["lead-ai-summary", leadId],
    enabled: Boolean(leadId),
    // The dialer is not live-updating this page; a stale read for a minute is
    // fine and keeps this off the hot path of every lead open.
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(
        `/api/dealer-leads/${encodeURIComponent(leadId)}/ai-summary`,
      );
      const json = await res.json();
      return json?.success ? (json.data as AiSummary) : null;
    },
  });

  const latest = data?.latest ?? null;
  const hasAiCall = Boolean(data?.hasAiCall && latest);

  // No AI call and no permission to add one: nothing useful to show, so show
  // nothing — the original AiSignalsCard behaviour.
  if (!hasAiCall && !canReview) return null;

  if (!hasAiCall) {
    return (
      <div className="space-y-3">
        <AttachedRecordings
          leadId={leadId}
          callId={null}
          canReview={canReview}
          hasAiRecording={false}
        />
      </div>
    );
  }

  const panelData: AiSignalsData = {
    band: latest!.band,
    callStatus: latest!.callStatus,
    infoSignalsCount: latest!.infoSignalsCount,
    scoreBreakdown: latest!.scoreBreakdown as AiSignalsData["scoreBreakdown"],
    intentScore: latest!.intentScore,
    summary: latest!.summary,
    calledAt: latest!.calledAt,
    connected: Boolean(data?.connected),
    recordingUrl: latest!.recordingUrl,
    callDuration: latest!.callDuration,
  };

  const provenance = data?.provenance ?? null;
  const isOverridden = provenance?.source === "human";

  return (
    <div className="space-y-3">
      <AiSignalsPanel
        data={panelData}
        variant="panel"
        footer={
          <div className="mt-3 space-y-3">
            {/* Why the number on this lead may not match the band above. The
                panel shows what the AI concluded; the lead now routes on the
                human answer. Leaving that unexplained is how a corrected lead
                becomes a support ticket. */}
            {isOverridden && (
              <p className="text-[11px] text-emerald-700 flex items-start gap-1.5 rounded-lg bg-emerald-50 border border-emerald-100 px-2 py-1.5">
                <UserCheck className="w-3 h-3 mt-px shrink-0" />
                <span>
                  This lead is routing on a human correction
                  {provenance?.overriddenByName && (
                    <> by {provenance.overriddenByName}</>
                  )}
                  , not on the AI band shown above.
                </span>
              </p>
            )}

            {/* The evidence, directly under the verdict it produced. Order is
                deliberate: the panel above states the band and the signal
                checklist (the "why"), this is the call it was read from, and the
                correction sits last. Asking someone to overrule a classifier
                without showing them the conversation is asking them to guess.

                `connected` is the route's own Boolean(transcript IS NOT NULL) —
                computed once in SQL so every consumer agrees on what "we have a
                transcript" means. */}
            <CallTranscript
              leadId={leadId}
              recordingUrl={latest!.recordingUrl}
              hasTranscript={Boolean(data?.connected)}
            />

            {canReview && (
              <CorrectIntentForm
                leadId={leadId}
                callId={latest!.callId}
                intentScore={latest!.intentScore}
                aiBand={latest!.band}
                signals={(latest!.signals as ClientSignals | null) ?? null}
              />
            )}
          </div>
        }
      />

      <AttachedRecordings
        leadId={leadId}
        callId={latest!.callId}
        canReview={canReview}
        hasAiRecording={Boolean(latest!.recordingUrl)}
      />
    </div>
  );
}
