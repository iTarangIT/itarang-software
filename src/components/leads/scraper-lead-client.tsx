"use client";

// components/leads/scraper-lead-client.tsx

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Phone,
  PhoneCall,
  TrendingUp,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Zap,
  AlertCircle,
  Loader2,
  ArrowRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface HistoryItem {
  attempt: number;
  outcome: string;
  transcript?: string;
  next_call_at?: string | null;
  analysis?: {
    intent_score?: number | string;
    engagement_depth?: number | string;
    urgency_signals?: number | string;
    objection_quality?: number | string;
    summary?: string;
  };
  called_at?: string;
}

interface Props {
  scraperLead: any;
  dealerLead: any | null;
  history: HistoryItem[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OUTCOME_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  callback_requested: { label: "Callback Requested", color: "text-purple-700", bg: "bg-purple-50" },
  interested:         { label: "Interested",          color: "text-emerald-700", bg: "bg-emerald-50" },
  disqualified:       { label: "Not Interested",      color: "text-red-600",    bg: "bg-red-50" },
  no_answer:          { label: "No Answer",           color: "text-gray-500",   bg: "bg-gray-100" },
  unknown:            { label: "No Outcome",          color: "text-gray-500",   bg: "bg-gray-100" },
};

const PAGE_SIZE = 5;

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function getOutcome(key: string) {
  return OUTCOME_CONFIG[key] ?? OUTCOME_CONFIG.unknown;
}

// ─── Call & Promote Button ─────────────────────────────────────────────────────

function CallPromoteButton({ scraperLead, dealerLead, onPromoted }: {
  scraperLead: any;
  dealerLead: any | null;
  onPromoted: (newDealerLeadId: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [calling, setCalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCall = async () => {
    setError(null);

    // Step 1: Promote if not already a dealer lead
    let dealerLeadId = dealerLead?.id;

    if (!dealerLeadId) {
      setLoading(true);
      try {
        const res = await fetch(`/api/scraper-leads/${scraperLead.id}/promote`, {
          method: "POST",
        });
        const data = await res.json();
        if (!data.success) {
          setError(data.error || "Failed to promote lead");
          return;
        }
        dealerLeadId = data.dealerLeadId;
        onPromoted(dealerLeadId);
      } catch (e: any) {
        setError(e.message);
        return;
      } finally {
        setLoading(false);
      }
    }

    // Step 2: Trigger Bolna call
    setCalling(true);
    try {
      await fetch("/api/bolna/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: scraperLead.phone,
          leadId: dealerLeadId,
        }),
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCalling(false);
    }
  };

  if (!scraperLead.phone) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-gray-400">
        <AlertCircle className="w-3.5 h-3.5" />
        No phone number
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        onClick={handleCall}
        disabled={loading || calling}
        className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
      >
        {loading ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> Promoting lead...</>
        ) : calling ? (
          <><PhoneCall className="w-4 h-4 animate-pulse" /> Calling...</>
        ) : (
          <><Phone className="w-4 h-4" /> Call Now</>
        )}
      </button>
      {!dealerLead && !loading && (
        <p className="text-xs text-gray-400 flex items-center gap-1">
          <ArrowRight className="w-3 h-3" />
          Will auto-convert to dealer lead on first call
        </p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

// ─── Info Card ────────────────────────────────────────────────────────────────

function InfoCard({ scraperLead, dealerLead, history, onPromoted }: {
  scraperLead: any;
  dealerLead: any | null;
  history: HistoryItem[];
  onPromoted: (id: string) => void;
}) {
  const totalCalls = history.length;
  const intentScores = history
    .map((h) => Number(h.analysis?.intent_score))
    .filter((n) => !isNaN(n) && n > 0);
  const avgIntent = intentScores.length
    ? (intentScores.reduce((a, b) => a + b, 0) / intentScores.length).toFixed(1)
    : null;
  const lastCall = history.length ? history[history.length - 1] : null;
  const lastOutcome = lastCall ? getOutcome(lastCall.outcome) : null;

  const stats = [
    { icon: Phone,        label: "Total Calls",      value: totalCalls,             sub: "attempts made",         color: "text-blue-600",   bg: "bg-blue-50" },
    { icon: TrendingUp,   label: "Avg Intent Score",  value: avgIntent ?? "—",       sub: "across all calls",      color: "text-emerald-600", bg: "bg-emerald-50" },
    { icon: MessageSquare, label: "Latest Outcome",   value: lastOutcome?.label ?? "—", sub: lastCall ? formatDate(lastCall.called_at) : "no calls yet", color: "text-purple-600", bg: "bg-purple-50" },
    { icon: MessageSquare, label: "Transcripts",      value: history.filter((h) => h.transcript).length, sub: "calls with transcript", color: "text-amber-600", bg: "bg-amber-50" },
  ];

  return (
    <div className="space-y-4 mb-6">
      {/* Call action */}
      <div className="bg-white border rounded-xl p-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-gray-800 mb-1">Actions</p>
          {dealerLead ? (
            <p className="text-xs text-emerald-600 mb-3">
              ✓ Converted to dealer lead · ID: {dealerLead.id}
            </p>
          ) : (
            <p className="text-xs text-gray-400 mb-3">
              Not yet converted to dealer lead
            </p>
          )}
          <CallPromoteButton
            scraperLead={scraperLead}
            dealerLead={dealerLead}
            onPromoted={onPromoted}
          />
        </div>

        {dealerLead && (
          <a
            href={`/leads/${dealerLead.id}`}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-gray-200 rounded-lg hover:bg-gray-50 transition-all"
          >
            View Dealer Profile <ArrowRight className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Stat cards — only show if calls exist */}
      {totalCalls > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stats.map((s) => (
            <div key={s.label} className="bg-white border rounded-xl p-4">
              <div className={`w-8 h-8 rounded-lg ${s.bg} flex items-center justify-center mb-3`}>
                <s.icon className={`w-4 h-4 ${s.color}`} />
              </div>
              <p className="text-xs text-gray-400 mb-0.5">{s.label}</p>
              <p className="text-lg font-bold text-gray-900 leading-tight">{s.value}</p>
              <p className="text-xs text-gray-400 mt-0.5">{s.sub}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Transcript Viewer ────────────────────────────────────────────────────────

function TranscriptViewer({ transcript }: { transcript: string }) {
  const lines = transcript.split("\n").filter(Boolean);
  return (
    <div className="mt-3 bg-gray-50 border rounded-lg p-3 max-h-52 overflow-y-auto space-y-1.5">
      {lines.map((line, i) => {
        const isAgent = line.toLowerCase().startsWith("vikram") || line.toLowerCase().startsWith("agent");
        const isUser  = line.toLowerCase().startsWith("dealer") || line.toLowerCase().startsWith("customer") || line.toLowerCase().startsWith("user");
        return (
          <p key={i} className={`text-xs leading-relaxed ${isAgent ? "text-blue-700" : isUser ? "text-gray-800" : "text-gray-500"}`}>
            {line}
          </p>
        );
      })}
    </div>
  );
}

// ─── Call Card ────────────────────────────────────────────────────────────────

function CallCard({ item }: { item: HistoryItem }) {
  const [expanded, setExpanded] = useState(false);
  const outcome = getOutcome(item.outcome);

  const scores = [
    { label: "Intent",     value: item.analysis?.intent_score,     icon: TrendingUp,    color: "text-blue-500" },
    { label: "Engagement", value: item.analysis?.engagement_depth,  icon: MessageSquare, color: "text-emerald-500" },
    { label: "Urgency",    value: item.analysis?.urgency_signals,   icon: Zap,           color: "text-amber-500" },
    { label: "Objection",  value: item.analysis?.objection_quality, icon: AlertCircle,   color: "text-red-400" },
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
            <p className="text-sm font-medium text-gray-800">Attempt #{item.attempt}</p>
            <p className="text-xs text-gray-400">{formatDate(item.called_at ?? null)}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${outcome.bg} ${outcome.color}`}>
            {outcome.label}
          </span>
          {item.next_call_at && (
            <span className="text-xs text-blue-500 flex items-center gap-1">
              <Clock className="w-3 h-3" />{formatDate(item.next_call_at)}
            </span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t bg-gray-50/50">
          <div className="grid grid-cols-4 gap-2 pt-4 mb-3">
            {scores.map((s) => (
              <div key={s.label} className="bg-white border rounded-lg p-2.5 text-center">
                <s.icon className={`w-3.5 h-3.5 ${s.color} mx-auto mb-1`} />
                <p className="text-[10px] text-gray-400">{s.label}</p>
                <p className="text-sm font-semibold text-gray-800">{s.value ?? "—"}</p>
              </div>
            ))}
          </div>
          {item.analysis?.summary && (
            <div className="bg-violet-50 border border-violet-100 rounded-lg p-3 mb-3">
              <p className="text-xs text-violet-700 leading-relaxed">{item.analysis.summary}</p>
            </div>
          )}
          {item.transcript
            ? <TranscriptViewer transcript={item.transcript} />
            : <p className="text-xs text-gray-400 py-2">No transcript available.</p>
          }
        </div>
      )}
    </div>
  );
}

// ─── Call History ─────────────────────────────────────────────────────────────

function CallHistory({ history }: { history: HistoryItem[] }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const pageItems = [...history].reverse().slice(start, start + PAGE_SIZE);

  if (history.length === 0) {
    return (
      <div className="bg-white border rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-800 mb-4">Call History</h3>
        <div className="text-center py-10 text-gray-400">
          <Phone className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No calls made yet</p>
          <p className="text-xs text-gray-400 mt-1">Make the first call using the button above</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-800">
          Call History
          <span className="ml-2 text-xs font-normal text-gray-400">({history.length} total)</span>
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
      <div className="space-y-3">
        {pageItems.map((item, i) => <CallCard key={start + i} item={item} />)}
      </div>
      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
          {Array.from({ length: totalPages }).map((_, i) => (
            <button key={i} onClick={() => setPage(i + 1)} className={`w-1.5 h-1.5 rounded-full transition-colors ${page === i + 1 ? "bg-gray-800" : "bg-gray-300"}`} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Root Export ──────────────────────────────────────────────────────────────

export function ScraperLeadClient({ scraperLead, dealerLead: initialDealerLead, history }: Props) {
  const router = useRouter();
  const [dealerLead, setDealerLead] = useState(initialDealerLead);

  const handlePromoted = (newDealerLeadId: string) => {
    // Refresh page to get updated dealer lead data
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <InfoCard
        scraperLead={scraperLead}
        dealerLead={dealerLead}
        history={history}
        onPromoted={handlePromoted}
      />
      <CallHistory history={history} />
    </div>
  );
}