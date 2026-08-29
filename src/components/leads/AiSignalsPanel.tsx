"use client";

// What the AI learned on a call — the band, the yes/no signal checklist, and the
// evidence quote behind each one.
//
// Extracted from CampaignLeadTranscriptDrawer so the lead-detail screens and the
// drawer render the identical thing. The drawer was the ONLY place this existed,
// and it is reachable only from inside a campaign — so the people who act on
// leads could not see what the robot had already found out.
//
// THREE STATES, and the middle one is the normal case rather than an edge case.
// Measured on database-1: 298 AI calls, 83 with a transcript, but only 27 with
// signals and 4 with a band. So "a call happened and nothing was extracted" is
// what most leads with any AI history actually look like, and the drawer used to
// render NOTHING at all for those — isBandBreakdown() is false for a null
// breakdown, and both legacy fallbacks then fail too.

import { CheckCircle2, Sparkles, X } from "lucide-react";

export type BandSignalLine = {
  signal: string;
  label: string;
  present: boolean;
  info: boolean;
  evidence: string;
};

export type AiSignalsData = {
  band: string | null;
  callStatus: string | null;
  infoSignalsCount: number | null;
  scoreBreakdown: BandSignalLine[] | null;
  intentScore: number | null;
  summary: string | null;
  calledAt: string | null;
  connected: boolean;
  recordingUrl: string | null;
  callDuration: number | null;
};

/** True when a stored score_breakdown is the band shape, not the old additive one. */
export function isBandBreakdown(rows: unknown): rows is BandSignalLine[] {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    typeof rows[0] === "object" &&
    rows[0] !== null &&
    "present" in (rows[0] as object)
  );
}

const BAND_TONE: Record<string, string> = {
  Qualified: "bg-emerald-100 text-emerald-700 border-emerald-300",
  Warm: "bg-amber-100 text-amber-700 border-amber-300",
  Cold: "bg-sky-100 text-sky-700 border-sky-300",
  Disqualified: "bg-rose-100 text-rose-700 border-rose-300",
};

// Band chip + N/5 gauge. The Sparkles glyph is deliberate: a /leads row can now
// show a band chip, a disposition-bucket chip, an intent bucket and an interest
// level side by side — four scales, two of which disagree by design. The icon
// says "this one is the robot's read" without needing a legend.
export function BandHeader({
  band,
  infoCount,
  callStatus,
}: {
  band: string | null;
  infoCount: number | null;
  callStatus: string | null;
}) {
  const cls =
    (band && BAND_TONE[band]) || "bg-gray-100 text-gray-600 border-gray-300";
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span
        title="AI band — computed from the call, not the pipeline stage"
        className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full border ${cls}`}
      >
        <Sparkles className="w-3 h-3" />
        {band ?? "No band"}
      </span>
      {infoCount != null && (
        <span className="text-[11px] font-mono tabular-nums text-gray-500">
          {infoCount}/5 facts disclosed
        </span>
      )}
      {callStatus && callStatus !== "complete" && (
        <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
          {callStatus === "dropped_partial"
            ? "resume — call cut off"
            : callStatus.replace(/_/g, " ")}
        </span>
      )}
    </div>
  );
}

/** One yes/no checklist row of the band breakdown. */
export function BandSignalRow({ item }: { item: BandSignalLine }) {
  const showEvidence = item.evidence && item.evidence !== "unknown";
  return (
    <div className="flex items-start gap-2">
      {item.present ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
      ) : (
        <X className="w-4 h-4 text-gray-300 mt-0.5 flex-shrink-0" />
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`text-xs font-medium ${item.present ? "text-gray-800" : "text-gray-400"}`}
          >
            {item.label}
          </span>
          {item.info && (
            <span className="text-[9px] uppercase tracking-wide text-gray-400 bg-gray-100 rounded px-1 py-px">
              info
            </span>
          )}
        </div>
        {showEvidence && (
          <p
            className="text-[10px] text-gray-400 leading-snug truncate"
            title={item.evidence}
          >
            {item.evidence}
          </p>
        )}
      </div>
    </div>
  );
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function AiSignalsPanel({
  data,
  variant = "panel",
  footer,
}: {
  data: AiSignalsData | null;
  /** "panel" = boxed section for lead detail; "inline" = no chrome, for the drawer. */
  variant?: "panel" | "inline";
  /** The drawer passes its score-correction form here. Lead detail passes nothing. */
  footer?: React.ReactNode;
}) {
  // State 1 — no AI call. Render NOTHING. An empty "what the AI learned" box on
  // the ~97% of leads the dialer has never touched is pure noise.
  if (!data) return null;

  const hasBreakdown = isBandBreakdown(data.scoreBreakdown);
  const when = fmtWhen(data.calledAt);

  const body = (
    <>
      <BandHeader
        band={data.band}
        infoCount={data.infoSignalsCount}
        callStatus={data.callStatus}
      />

      <p className="mt-1.5 text-[11px] text-gray-500">
        {data.connected ? "AI spoke with this dealer" : "AI could not reach this dealer"}
        {when ? ` · ${when}` : ""}
        {data.callDuration ? ` · ${data.callDuration}s` : ""}
      </p>

      {data.summary && (
        <p className="mt-2 text-xs leading-relaxed text-gray-700">{data.summary}</p>
      )}

      {hasBreakdown ? (
        <div className="mt-3 space-y-2">
          {(data.scoreBreakdown as BandSignalLine[]).map((item) => (
            <BandSignalRow key={item.signal} item={item} />
          ))}
        </div>
      ) : (
        // State 2 — a call happened, nothing was extracted. Deliberately NOT an
        // 8-row all-"no" checklist: that reads as "the dealer refused
        // everything", which is a claim about the dealer we cannot support.
        <p className="mt-3 text-[11px] leading-relaxed text-gray-500 italic">
          No qualification signals were extracted from this call.
        </p>
      )}

      {footer}
    </>
  );

  if (variant === "inline") return <>{body}</>;

  return (
    <section className="rounded-xl border border-gray-100 bg-white p-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        What the AI learned
      </h3>
      {body}
    </section>
  );
}
