"use client";

// "The AI has already spoken with this dealer."
//
// Shown wherever the AI-connected hard block refuses a lead: the 409 from
// /api/bolna/call and /api/elevenlabs/call, and the excluded breakdown on the
// campaign confirm sheets. The point is not to say "no" — it is to hand over
// everything the AI learned and point at the next useful action, because the
// only remaining move is a human one.
//
// Reuses the existing transcript drawer rather than rendering a transcript
// itself: pass `campaignId` through and CampaignLeadTranscriptDrawer opens
// unmodified. A manual one-off call has no campaign, so there the link falls
// back to the lead page, which already lists ai_call_logs.

import Link from "next/link";
import { PhoneOff, FileText, UserRoundCheck } from "lucide-react";

export type AiConnectionSummary = {
  connected: boolean;
  callId: string | null;
  calledAt: string | null;
  durationSeconds: number | null;
  summary: string | null;
  band: string | null;
  callStatus: string | null;
  infoSignalsCount: number | null;
  totalConnectedCalls: number;
  campaignId: string | null;
  campaignName: string | null;
};

const BAND_TONE: Record<string, string> = {
  Qualified: "bg-emerald-100 text-emerald-700 border-emerald-300",
  Warm: "bg-amber-100 text-amber-700 border-amber-300",
  Cold: "bg-sky-100 text-sky-700 border-sky-300",
  Disqualified: "bg-rose-100 text-rose-700 border-rose-300",
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "earlier";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "earlier";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtDuration(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * The call summary, or an honest stand-in.
 *
 * A `needs_review` call stores a summary like "analysis_failed — timeout". That
 * is a note to us about OUR extraction failing, not a description of the
 * conversation, and printing it verbatim reads as if the dealer said something
 * incomprehensible. The call still counts as connected — the dealer really was
 * reached — so the lead is still blocked; we just say so truthfully.
 */
function readableSummary(summary: string | null): {
  text: string;
  analysisFailed: boolean;
} {
  const s = (summary ?? "").trim();
  if (!s) {
    return {
      text: "The AI reached this dealer, but no call summary was recorded.",
      analysisFailed: false,
    };
  }
  if (/^analysis[_ ]failed/i.test(s)) {
    return {
      text: "The AI reached this dealer, but the call could not be analysed — so there is no summary. The conversation still happened.",
      analysisFailed: true,
    };
  }
  return { text: s, analysisFailed: false };
}

export function AiAlreadyContactedNotice({
  leadId,
  leadName,
  connection,
  onFollowUpManually,
  onViewTranscript,
  className = "",
}: {
  leadId: string;
  leadName?: string | null;
  connection: AiConnectionSummary;
  /** Wired by the Inside Sales surfaces. Falls back to a link to the lead. */
  onFollowUpManually?: () => void;
  /** Opens CampaignLeadTranscriptDrawer with connection.campaignId. */
  onViewTranscript?: (campaignId: string, leadId: string) => void;
  className?: string;
}) {
  if (!connection.connected) return null;

  const { text, analysisFailed } = readableSummary(connection.summary);
  const duration = fmtDuration(connection.durationSeconds);
  const bandCls =
    (connection.band && BAND_TONE[connection.band]) ||
    "bg-gray-100 text-gray-600 border-gray-300";

  return (
    <div
      className={`rounded-lg border border-amber-200 bg-amber-50 p-4 ${className}`}
    >
      <div className="flex items-start gap-3">
        <PhoneOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">
            Already contacted by AI
          </p>

          <p className="mt-0.5 text-xs text-amber-800">
            {leadName ? <span className="font-medium">{leadName}</span> : "This dealer"}
            {" — the AI spoke with them on "}
            {fmtWhen(connection.calledAt)}
            {duration ? ` · ${duration}` : ""}
            {connection.totalConnectedCalls > 1
              ? ` · ${connection.totalConnectedCalls} conversations`
              : ""}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold ${bandCls}`}
            >
              {connection.band ?? "No band"}
            </span>
            {connection.infoSignalsCount != null && (
              <span className="font-mono text-[11px] tabular-nums text-amber-700">
                {connection.infoSignalsCount}/5 facts disclosed
              </span>
            )}
            {connection.campaignName && (
              <span className="truncate text-[11px] text-amber-700">
                via {connection.campaignName}
              </span>
            )}
          </div>

          <p
            className={`mt-2 text-xs leading-relaxed ${
              analysisFailed ? "italic text-amber-700" : "text-amber-900"
            }`}
          >
            {text}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {connection.campaignId && onViewTranscript ? (
              <button
                type="button"
                onClick={() =>
                  onViewTranscript(connection.campaignId as string, leadId)
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                <FileText className="h-3.5 w-3.5" />
                View transcript
              </button>
            ) : (
              <Link
                href={`/leads/${leadId}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                <FileText className="h-3.5 w-3.5" />
                View call history
              </Link>
            )}

            {onFollowUpManually ? (
              <button
                type="button"
                onClick={onFollowUpManually}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                <UserRoundCheck className="h-3.5 w-3.5" />
                Follow up manually
              </button>
            ) : (
              <Link
                href={`/leads/${leadId}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                <UserRoundCheck className="h-3.5 w-3.5" />
                Follow up manually
              </Link>
            )}
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-amber-700">
            The AI cannot call this dealer again — follow-up calling is not
            supported yet, so a second robot call would only repeat the first.
            They are still available to the calling team.
          </p>
        </div>
      </div>
    </div>
  );
}
