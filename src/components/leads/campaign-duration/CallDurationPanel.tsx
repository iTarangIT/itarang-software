// The analysis section that opens when the Completed stat card is clicked.
//
// It answers one question in four parts: WHERE are this campaign's calls being
// lost, and why. Reading order is deliberate and is not the order the data was
// built in —
//
//   1. the greeting cliff, when it fires. On the stored transcripts 44 of 83
//      connected calls end inside the AI's opening sentence at a median of
//      seven seconds, and when that is true every number below it is a
//      consequence rather than a finding;
//   2. the funnel — attempted, placed, answered, then what happened on the
//      call — on THREE separate denominators, because the evidence thins out
//      as you go down and blending them would report "2% qualify" when the
//      truth is "we almost never score a call";
//   3. the duration distribution, the shape of the calls that survived;
//   4. the opening-line table, the only section that proposes an action.
//
// Parts 2-4 each survive the others being empty. A campaign with no stored
// transcripts still gets part 3; one with no reported durations still gets
// parts 1, 2 and 4.
//
// THE AGGREGATE IS SERVER-SIDE, DELIBERATELY. The obvious shortcut is to bucket
// the rows the lead table already loaded, but that table caps at 100 rows per
// status or 50 per page, so the shortcut would report a confident, precise,
// WRONG number — on the one panel whose entire value is being believed.
//
// FETCHING IS GATED BY MOUNTING, not by an `enabled` flag: the parent renders
// this only while the panel is open. Closing it drops the observer but leaves
// the cache entry, so reopening paints instantly and revalidates in the
// background.
"use client";

import * as React from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertCircle, Clock } from "lucide-react";
import { BucketOutcomeLegend } from "./BucketOutcomeLegend";
import { CallFunnel } from "./CallFunnel";
import { GreetingCliff } from "./GreetingCliff";
import { OpeningScriptTable } from "./OpeningScriptTable";
import { DurationHistogram } from "./DurationHistogram";
import { DurationSummaryStrip } from "./DurationSummaryStrip";
import type { CallQualityResponse } from "./types";

function PanelShell({
  id,
  children,
  footer,
}: {
  id: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby="campaign-duration-title"
      className="rounded-2xl border border-gray-200 bg-white shadow-sm"
    >
      <div className="px-6 pt-5 pb-3">
        <div className="mb-1 flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-gray-400" />
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
            Call quality
          </span>
        </div>
        <h3
          id="campaign-duration-title"
          className="text-base font-bold tracking-tight text-gray-900"
        >
          Where these calls are being lost
        </h3>
      </div>

      <div className="px-6 pb-5">{children}</div>
      {footer}
    </section>
  );
}

/** Six grey rows at the real bar height — a spinner would collapse the panel
 *  to ~40px and then jump it to ~340px on arrival. */
function LoadingBody() {
  return (
    <div>
      {/* Four tiles then the plot — the same three-band shape the loaded panel
          has, so arrival does not reflow the page. */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[86px] animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
      <div className="flex items-end gap-1.5" style={{ height: 150 }}>
        {[0.5, 0.8, 0.6, 0.7, 0.45, 0.3].map((h, i) => (
          <div
            key={i}
            className="flex-1 animate-pulse rounded-t bg-gray-100"
            style={{ height: `${h * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 h-3 border-t border-gray-100" />
    </div>
  );
}

function EmptyBody({ message, detail }: { message: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-gray-50">
        <Clock className="h-4 w-4 text-gray-300" />
      </div>
      <p className="text-sm font-medium text-gray-700">{message}</p>
      <p className="mt-0.5 max-w-md text-xs text-gray-400">{detail}</p>
    </div>
  );
}

export function CallDurationPanel({
  id,
  campaignId,
  isRunning,
  selectedBucket,
  onSelectBucket,
}: {
  id: string;
  campaignId: string;
  isRunning: boolean;
  selectedBucket: string | null;
  /** Carries the label so the table's filter chip can name the bucket. */
  onSelectBucket: (next: { key: string; label: string } | null) => void;
}) {
  const { data, isLoading, isError, error, refetch } = useQuery<CallQualityResponse>({
    queryKey: ["dialer-campaign-duration", campaignId],
    queryFn: async () => {
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/duration-histogram`,
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Failed");
      return json.data as CallQualityResponse;
    },
    // 10s while running, not the campaign header's 4s: this is a whole-campaign
    // aggregate that moves by one call every half-minute at best, and it is the
    // most expensive query on the page.
    refetchInterval: isRunning ? 10000 : false,
    // Bars hold their last value through a refetch instead of collapsing to a
    // skeleton every ten seconds on a live campaign.
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  if (isLoading && !data) {
    return (
      <PanelShell id={id}>
        <LoadingBody />
      </PanelShell>
    );
  }

  if (isError && !data) {
    return (
      <PanelShell id={id}>
        {/* Never fall through to zero bars on an error — that reads as "no short
            calls", the exact opposite of what an unknown result means. */}
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <p className="font-medium">Could not load the duration breakdown.</p>
            <p className="mt-0.5 text-rose-600/80">
              {error instanceof Error ? error.message : "Unknown error"}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-1.5 cursor-pointer font-semibold underline hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
            >
              Retry
            </button>
          </div>
        </div>
      </PanelShell>
    );
  }

  if (!data) return null;

  const { buckets, totals } = data;

  if (totals.attemptedLeads === 0) {
    return (
      <PanelShell id={id}>
        <EmptyBody
          message="No calls have been placed yet."
          detail="This breakdown appears once the campaign starts dialling."
        />
      </PanelShell>
    );
  }

  // No usable duration does NOT mean nothing to show. The funnel is computed
  // from outcomes and transcripts, so "how far did these calls get" survives a
  // provider that never reported a single duration — and that combination is
  // common, not exotic: every campaign dialled before the ElevenLabs migration
  // looks exactly like this. Returning early here (as this panel used to) threw
  // away the half of the analysis that still worked.
  const hasHistogram = totals.bucketedConnected > 0;

  return (
    <PanelShell
      id={id}
      footer={
        data.config.source === "app_settings" ? (
          <div className="border-t border-gray-100 px-6 py-2.5 text-[11px] text-gray-400">
            Bucket boundaries are configured for this environment, not the defaults.
          </div>
        ) : null
      }
    >
      {/* The order is the order the question gets asked. The greeting cliff
          first, because when it fires it is the finding that changes what you
          do and every number below it is a consequence. Then the funnel: where
          the calls went. Then the duration distribution, which is the shape of
          the calls that survived. The script table last, because it is the
          only section that proposes an action rather than a measurement.

          The summary strip is not decoration. Its closing paragraph is the only
          place that names every denominator in words, and without it the
          chart's "N measured calls" sits unexplained next to a Completed card
          showing a different number, which reads as a bug and costs the panel
          its credibility. See DurationSummaryStrip's header. */}
      <GreetingCliff funnel={data.funnel} />

      <div className="mt-5">
        <CallFunnel funnel={data.funnel} />
      </div>

      <div className="mt-6 border-t border-gray-100 pt-5">
        {hasHistogram ? (
          <>
            <DurationSummaryStrip
              totals={totals}
              shortestLabel={buckets[0]?.label ?? "20s"}
            />

            <div className="mt-5">
              <DurationHistogram
                buckets={buckets}
                bucketedConnected={totals.bucketedConnected}
                selected={selectedBucket}
                onSelect={(key) => {
                  if (selectedBucket === key) return onSelectBucket(null);
                  const hit = buckets.find((b) => b.key === key);
                  onSelectBucket(hit ? { key: hit.key, label: hit.label } : null);
                }}
              />
            </div>

            <div className="mt-4">
              <BucketOutcomeLegend
                buckets={buckets}
                selected={selectedBucket}
                onClear={() => onSelectBucket(null)}
              />
            </div>
          </>
        ) : (
          <EmptyBody
            message={
              totals.connectedLeads > 0
                ? `${totals.connectedLeads} call${totals.connectedLeads === 1 ? "" : "s"} connected, none with a recorded duration yet.`
                : "No call has reached a dealer yet."
            }
            detail={
              totals.connectedLeads > 0
                ? "Durations arrive with the provider webhook, usually within a minute of the call ending. The stages above do not depend on them."
                : `${totals.attemptedLeads} call${totals.attemptedLeads === 1 ? " was" : "s were"} taken off the queue but none produced a conversation. The Failed tab explains why.`
            }
          />
        )}
      </div>

      {data.funnel.openingScripts.length > 0 && (
        <div className="mt-6 border-t border-gray-100 pt-5">
          <OpeningScriptTable scripts={data.funnel.openingScripts} />
        </div>
      )}
    </PanelShell>
  );
}
