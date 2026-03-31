"use client";

import React, { useState } from "react";
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
  Zap,
  AlertCircle,
} from "lucide-react";

interface Analysis {
  intent_score?: number | string;
  engagement_depth?: number | string;
  urgency_signals?: number | string;
  objection_quality?: number | string;
  summary?: string;
  key_insights?: string[];
}

interface HistoryItem {
  attempt: number;
  outcome: string;
  transcript?: string;
  next_call_at?: string | null;
  analysis?: Analysis;
  called_at?: string;
}

interface Props {
  history: HistoryItem[];
  lead: any;
}

const OUTCOME_CONFIG: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  callback_requested: {
    label: "Callback Requested",
    color: "text-purple-700",
    bg: "bg-purple-50",
  },
  interested: {
    label: "Interested",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
  },
  disqualified: {
    label: "Not Interested",
    color: "text-red-600",
    bg: "bg-red-50",
  },
  no_answer: { label: "No Answer", color: "text-gray-500", bg: "bg-gray-100" },
  unknown: { label: "No Outcome", color: "text-gray-500", bg: "bg-gray-100" },
};

const PAGE_SIZE = 5;

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function avg(arr: number[]) {
  if (!arr.length) return null;
  return (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
}

function getOutcome(key: string) {
  return OUTCOME_CONFIG[key] ?? OUTCOME_CONFIG.unknown;
}

function SummaryBlock({ history }: { history: HistoryItem[] }) {
  const totalCalls = history.length;
  const intentScores = history
    .map((h) => Number(h.analysis?.intent_score))
    .filter((n) => !isNaN(n) && n > 0);
  const avgIntent = avg(intentScores);
  const latestOutcome = history.length
    ? getOutcome(history[history.length - 1].outcome)
    : null;
  const lastCall = history.length ? history[history.length - 1] : null;
  const allInsights: string[] = history.flatMap(
    (h) => h.analysis?.key_insights ?? [],
  );
  const uniqueInsights = [...new Set(allInsights)].slice(0, 4);
  const latestSummary = [...history].reverse().find((h) => h.analysis?.summary)
    ?.analysis?.summary;

  const stats = [
    {
      icon: Phone,
      label: "Total Calls",
      value: totalCalls,
      sub: "attempts made",
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      icon: TrendingUp,
      label: "Avg Intent Score",
      value: avgIntent ?? "—",
      sub: "across all calls",
      color: "text-emerald-600",
      bg: "bg-emerald-50",
    },
    {
      icon: Target,
      label: "Latest Status",
      value: latestOutcome?.label ?? "—",
      sub: lastCall ? formatDate(lastCall.called_at ?? null) : "no calls yet",
      color: "text-purple-600",
      bg: "bg-purple-50",
    },
    {
      icon: MessageSquare,
      label: "Transcripts",
      value: history.filter((h) => h.transcript).length,
      sub: "calls with transcript",
      color: "text-amber-600",
      bg: "bg-amber-50",
    },
  ];

  return (
    <div className="space-y-4 mb-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-white border rounded-xl p-4">
            <div
              className={`w-8 h-8 rounded-lg ${s.bg} flex items-center justify-center mb-3`}
            >
              <s.icon className={`w-4 h-4 ${s.color}`} />
            </div>
            <p className="text-xs text-gray-400 mb-0.5">{s.label}</p>
            <p className="text-lg font-bold text-gray-900 leading-tight">
              {s.value}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>

      {(latestSummary || uniqueInsights.length > 0) && (
        <div className="bg-white border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 bg-violet-50 rounded-lg flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-violet-600" />
            </div>
            <h3 className="text-sm font-semibold text-gray-800">AI Insights</h3>
          </div>

          {latestSummary && (
            <p className="text-sm text-gray-600 mb-4 leading-relaxed border-l-2 border-violet-200 pl-3">
              {latestSummary}
            </p>
          )}

          {uniqueInsights.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {uniqueInsights.map((insight, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 bg-gray-50 rounded-lg p-3"
                >
                  <Zap className="w-3.5 h-3.5 text-violet-500 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-gray-600">{insight}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TranscriptViewer({ transcript }: { transcript: string }) {
  const lines = transcript.split("\n").filter(Boolean);
  return (
    <div className="mt-3 bg-gray-50 border rounded-lg p-3 max-h-52 overflow-y-auto space-y-1.5">
      {lines.map((line, i) => {
        const isAgent =
          line.toLowerCase().startsWith("vikram") ||
          line.toLowerCase().startsWith("agent");
        const isUser =
          line.toLowerCase().startsWith("dealer") ||
          line.toLowerCase().startsWith("customer") ||
          line.toLowerCase().startsWith("user");
        return (
          <p
            key={i}
            className={`text-xs leading-relaxed ${
              isAgent
                ? "text-blue-700"
                : isUser
                  ? "text-gray-800"
                  : "text-gray-500"
            }`}
          >
            {line}
          </p>
        );
      })}
    </div>
  );
}

function CallCard({ item, index }: { item: HistoryItem; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const outcome = getOutcome(item.outcome);

  const scores = [
    {
      label: "Intent",
      value: item.analysis?.intent_score,
      icon: TrendingUp,
      color: "text-blue-500",
    },
    {
      label: "Engagement",
      value: item.analysis?.engagement_depth,
      icon: MessageSquare,
      color: "text-emerald-500",
    },
    {
      label: "Urgency",
      value: item.analysis?.urgency_signals,
      icon: Zap,
      color: "text-amber-500",
    },
    {
      label: "Objection",
      value: item.analysis?.objection_quality,
      icon: AlertCircle,
      color: "text-red-400",
    },
  ];

  return (
    <div className="bg-white border rounded-xl overflow-hidden">
      <div
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-xs font-bold text-gray-600">
            {item.attempt}
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800">
              Attempt #{item.attempt}
            </p>
            <p className="text-xs text-gray-400">
              {formatDate(item.called_at ?? null)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`text-xs px-2.5 py-1 rounded-full font-medium ${outcome.bg} ${outcome.color}`}
          >
            {outcome.label}
          </span>
          {item.next_call_at && (
            <span className="text-xs text-blue-500 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDate(item.next_call_at)}
            </span>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t bg-gray-50/50">
          <div className="grid grid-cols-4 gap-2 pt-4 mb-3">
            {scores.map((s) => (
              <div
                key={s.label}
                className="bg-white border rounded-lg p-2.5 text-center"
              >
                <s.icon className={`w-3.5 h-3.5 ${s.color} mx-auto mb-1`} />
                <p className="text-[10px] text-gray-400">{s.label}</p>
                <p className="text-sm font-semibold text-gray-800">
                  {s.value ?? "—"}
                </p>
              </div>
            ))}
          </div>

          {item.analysis?.summary && (
            <div className="bg-violet-50 border border-violet-100 rounded-lg p-3 mb-3">
              <p className="text-xs text-violet-700 leading-relaxed">
                {item.analysis.summary}
              </p>
            </div>
          )}

          {item.transcript ? (
            <TranscriptViewer transcript={item.transcript} />
          ) : (
            <p className="text-xs text-gray-400 py-2">
              No transcript available.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CallHistory({ history }: { history: HistoryItem[] }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const pageItems = [...history].reverse().slice(start, start + PAGE_SIZE);

  return (
    <div className="bg-white border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-800">
          Call History
          <span className="ml-2 text-xs font-normal text-gray-400">
            ({history.length} total)
          </span>
        </h3>
        {totalPages > 1 && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span>
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {history.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          <Phone className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No calls made yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pageItems.map((item, i) => (
            <CallCard key={start + i} item={item} index={start + i} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: totalPages }).map((_, i) => (
            <button
              key={i}
              onClick={() => setPage(i + 1)}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                page === i + 1 ? "bg-gray-800" : "bg-gray-300"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function LeadDetailClient({ history, lead }: Props) {
  return (
    <div className="space-y-4">
      <SummaryBlock history={history} />
      <CallHistory history={history} />
    </div>
  );
}
