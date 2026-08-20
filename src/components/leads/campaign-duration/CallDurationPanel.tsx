// The analysis section that opens when the Completed stat card is clicked.
//
// It answers one question: how fast are this campaign's connected calls dying,
// and why. Production data has put the median AI call around eleven seconds,
// with roughly seven in ten connected calls ending inside twenty — a signal that
// until now only existed in an offline script. Seeing it per campaign is what
// lets someone tell a bad campaign from a bad script.
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
import { DurationHistogram } from "./DurationHistogram";
import type { DurationHistogramResponse } from "./types";

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
          How long the connected calls lasted
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
  const { data, isLoading, isError, error, refetch } = useQuery<DurationHistogramResponse>({
    queryKey: ["dialer-campaign-duration", campaignId],
    queryFn: async () => {
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/duration-histogram`,
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Failed");
      return json.data as DurationHistogramResponse;
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

  // The state that actually happens on a running campaign: rows have finished
  // but the provider has not reported durations yet.
  if (totals.bucketedConnected === 0) {
    return (
      <PanelShell id={id}>
        <EmptyBody
          message={
            totals.connectedLeads > 0
              ? `${totals.connectedLeads} call${totals.connectedLeads === 1 ? "" : "s"} connected, none with a recorded duration yet.`
              : "No call has reached a dealer yet."
          }
          detail={
            totals.connectedLeads > 0
              ? "Durations arrive with the provider webhook, usually within a minute of the call ending."
              : `${totals.attemptedLeads} call${totals.attemptedLeads === 1 ? " was" : "s were"} dialled but none produced a conversation. The Failed tab explains why.`
          }
        />
      </PanelShell>
    );
  }

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
    </PanelShell>
  );
}
