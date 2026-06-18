"use client";

import React, { useState, useEffect } from "react";
import {
  Phone,
  TrendingUp,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Clock,
  Target,
  FileText,
  Loader2,
  PhoneCall,
  Radio,
} from "lucide-react";
import type { CallItem } from "@/lib/leads/normalizeCalls";

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  calls: CallItem[];
  lead: any;
}

// ─── Visual config ────────────────────────────────────────────────────────────

const BAND_CHIP: Record<string, string> = {
  qualified: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warm: "bg-amber-50 text-amber-700 border-amber-200",
  cold: "bg-blue-50 text-blue-700 border-blue-200",
  disqualified: "bg-gray-100 text-gray-500 border-gray-200",
};

const CALL_STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  complete: { label: "Complete", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  dropped_partial: { label: "Dropped (partial)", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  dropped_empty: { label: "Dropped (empty)", cls: "bg-gray-100 text-gray-500 border-gray-200" },
};

// Telephony / legacy outcome labels for calls with no band (no-answer, busy …).
const OUTCOME_LABEL: Record<string, string> = {
  callback_requested: "Callback Requested",
  interested: "Interested",
  disqualified: "Not Interested",
  not_interested: "Not Interested",
  no_answer: "No Answer",
  busy: "Busy",
  failed: "Failed",
  completed: "Completed",
  dropped_empty: "Dropped (empty)",
  unknown: "No Outcome",
};

const PAGE_SIZE = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatDuration(sec: number | null | undefined) {
  if (sec == null || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function avg(arr: number[]) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function titleCase(v: string) {
  return v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function BandChip({ band }: { band: string | null }) {
  if (!band) return null;
  const cls = BAND_CHIP[band.toLowerCase()] ?? "bg-gray-100 text-gray-500 border-gray-200";
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${cls}`}>
      {band}
    </span>
  );
}

function CallStatusChip({ status }: { status: string | null }) {
  if (!status) return null;
  const c = CALL_STATUS_CHIP[status] ?? { label: titleCase(status), cls: "bg-gray-100 text-gray-500 border-gray-200" };
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${c.cls}`}>
      {c.label}
    </span>
  );
}

// One short label summarising the call result, used in the row + Latest Status.
function resultLabel(c: CallItem): string {
  if (c.band) return c.band;
  if (c.call_status) return CALL_STATUS_CHIP[c.call_status]?.label ?? titleCase(c.call_status);
  if (c.outcome) return OUTCOME_LABEL[c.outcome] ?? titleCase(c.outcome);
  if (c.status) return OUTCOME_LABEL[c.status] ?? titleCase(c.status);
  return "—";
}

// ─── Overall Summary ──────────────────────────────────────────────────────────

function OverallSummary({ calls, lead }: { calls: CallItem[]; lead: any }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<"saved" | "generated">("generated");

  const transcriptCount = calls.filter((c) => c.transcript).length;

  useEffect(() => {
    if (lead?.overall_summary) {
      setSummary(lead.overall_summary);
      setSource("saved");
      return;
    }

    const transcripts = calls
      .filter((c) => c.transcript)
      .map((c) => `--- Attempt #${c.index} (${formatDate(c.when)}) ---\n${c.transcript}`)
      .join("\n\n");

    if (!transcripts) {
      setSummary("No transcripts available to generate a summary.");
      return;
    }

    setLoading(true);
    fetch("/api/leads/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcripts,
        dealerName: lead?.dealer_name,
        shopName: lead?.shop_name,
        location: lead?.location,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        const generated = data.summary;
        if (!generated) return;
        setSummary(generated);
        setSource("generated");
        fetch(`/api/leads/${lead.id}/summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summary: generated }),
        }).catch(() => console.warn("[summary] failed to save to DB"));
      })
      .catch(() => setSummary("Unable to generate summary at this time."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-white border border-gray-100 shadow-sm rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 bg-slate-100 rounded-lg flex items-center justify-center">
          <FileText className="w-3.5 h-3.5 text-slate-600" />
        </div>
        <h3 className="text-sm font-semibold text-gray-800">Overall Summary</h3>
        {!loading && summary && (
          <span className="ml-auto text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
            {source === "saved" ? "saved" : "AI generated"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Generating summary across {transcriptCount} transcripts…</span>
        </div>
      ) : summary ? (
        <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">{summary}</p>
      ) : (
        <p className="text-sm text-gray-400">No summary available.</p>
      )}
    </div>
  );
}

// ─── Summary Stats Block ──────────────────────────────────────────────────────

function SummaryBlock({ calls }: { calls: CallItem[] }) {
  const totalCalls = calls.length;
  const intentScores = calls
    .map((c) => c.intent_score)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const avgIntent = avg(intentScores);
  const latest = calls.length ? calls[calls.length - 1] : null;

  const stats = [
    { icon: PhoneCall, label: "Total Calls", value: totalCalls, sub: "attempts made", color: "text-blue-600", bg: "bg-blue-50" },
    { icon: TrendingUp, label: "Avg Intent Score", value: avgIntent ?? "—", sub: "across all calls", color: "text-emerald-600", bg: "bg-emerald-50" },
    { icon: Target, label: "Latest Status", value: latest ? resultLabel(latest) : "—", sub: latest ? formatDate(latest.when) : "no calls yet", color: "text-purple-600", bg: "bg-purple-50" },
    { icon: MessageSquare, label: "Transcripts", value: calls.filter((c) => c.transcript).length, sub: "calls with transcript", color: "text-amber-600", bg: "bg-amber-50" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((s) => (
        <div key={s.label} className="bg-white border border-gray-100 shadow-sm rounded-xl p-4">
          <div className={`w-8 h-8 rounded-lg ${s.bg} flex items-center justify-center mb-3`}>
            <s.icon className={`w-4 h-4 ${s.color}`} />
          </div>
          <p className="text-xs text-gray-400 mb-0.5">{s.label}</p>
          <p className="text-lg font-bold text-gray-900 leading-tight truncate" title={String(s.value)}>{s.value}</p>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{s.sub}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Transcript Viewer ────────────────────────────────────────────────────────

function speakerOf(line: string): "agent" | "user" | "other" {
  const head = line.slice(0, 24).toLowerCase();
  if (/^(agent|priya|ai)\b|^(agent|priya)\s*:/.test(head)) return "agent";
  if (/^(user|dealer|customer|caller)\b|^(user|dealer|customer)\s*:/.test(head)) return "user";
  return "other";
}

function TranscriptViewer({ transcript }: { transcript: string }) {
  const lines = transcript.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div className="mt-3 bg-gray-50 border border-gray-100 rounded-lg p-3 max-h-60 overflow-y-auto space-y-1.5">
      {lines.map((line, i) => {
        const who = speakerOf(line);
        return (
          <p
            key={i}
            className={`text-xs leading-relaxed ${
              who === "agent" ? "text-blue-700" : who === "user" ? "text-gray-900 font-medium" : "text-gray-500"
            }`}
          >
            {line}
          </p>
        );
      })}
    </div>
  );
}

// ─── Call Card ────────────────────────────────────────────────────────────────

function CallCard({ item }: { item: CallItem }) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatDuration(item.duration);

  return (
    <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-xs font-bold text-gray-600">
            {item.index}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-gray-800">Attempt #{item.index}</p>
              {item.provider && (
                <span className="text-[10px] uppercase tracking-wide text-gray-400">{item.provider}</span>
              )}
            </div>
            <p className="text-xs text-gray-400">{formatDate(item.when)}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <BandChip band={item.band} />
          <CallStatusChip status={item.call_status} />
          {!item.band && !item.call_status && (
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 bg-gray-100 text-gray-500 font-medium">
              {resultLabel(item)}
            </span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100 bg-gray-50/40">
          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pt-3 text-xs text-gray-500">
            {item.intent_score != null && (
              <span className="inline-flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5 text-blue-500" />
                Intent <span className="font-semibold text-gray-800">{item.intent_score}</span>
              </span>
            )}
            {item.info_signals_count != null && (
              <span className="inline-flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-violet-500" />
                {item.info_signals_count} signal{item.info_signals_count === 1 ? "" : "s"}
              </span>
            )}
            {duration && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-gray-400" />
                {duration}
              </span>
            )}
            {item.next_call_at && (
              <span className="inline-flex items-center gap-1 text-blue-500">
                <Clock className="w-3 h-3" />
                Next: {formatDate(item.next_call_at)}
              </span>
            )}
          </div>

          {/* Recording */}
          {item.recording_url && (
            <div className="mt-3 flex items-center gap-2">
              <Radio className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <audio controls preload="none" src={item.recording_url} className="h-9 w-full max-w-md" />
            </div>
          )}

          {/* Per-call summary */}
          {item.summary && (
            <div className="mt-3 bg-violet-50 border border-violet-100 rounded-lg p-3">
              <p className="text-xs text-violet-700 leading-relaxed whitespace-pre-wrap">{item.summary}</p>
            </div>
          )}

          {/* Transcript */}
          {item.transcript ? (
            <TranscriptViewer transcript={item.transcript} />
          ) : (
            <p className="text-xs text-gray-400 py-2">No transcript captured for this call.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Call History ─────────────────────────────────────────────────────────────

function CallHistory({ calls }: { calls: CallItem[] }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(calls.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  // Newest first for display.
  const ordered = [...calls].reverse();
  const pageItems = ordered.slice(start, start + PAGE_SIZE);

  return (
    <div className="bg-white border border-gray-100 shadow-sm rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-800">
          Call History
          <span className="ml-2 text-xs font-normal text-gray-400">({calls.length} total)</span>
        </h3>
        {totalPages > 1 && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span>Page {page} of {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {calls.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <Phone className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No calls made yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pageItems.map((item) => (
            <CallCard key={item.key} item={item} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: totalPages }).map((_, i) => (
            <button
              key={i}
              onClick={() => setPage(i + 1)}
              aria-label={`Page ${i + 1}`}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${page === i + 1 ? "bg-gray-800" : "bg-gray-300"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Root Export ──────────────────────────────────────────────────────────────

export function LeadDetailClient({ calls, lead }: Props) {
  return (
    <div className="space-y-4">
      <SummaryBlock calls={calls} />
      <OverallSummary calls={calls} lead={lead} />
      <CallHistory calls={calls} />
    </div>
  );
}
