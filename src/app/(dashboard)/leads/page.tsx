"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  Plus,
  Phone,
  MapPin,
  Store,
  User,
  TrendingUp,
  Clock,
  RefreshCw,
  AlertCircle,
  Search,
  ChevronLeft,
  ChevronRight,
  Globe,
  Calendar,
  Zap,
  StopCircle,
  PhoneCall,
} from "lucide-react";
import { CallButton } from "@/components/leads/call-button";

type Tab = "leads" | "scraper" | "converted";
type DialerPhase = "idle" | "calling" | "countdown";

// ─── STATUS CONFIGS ───────────────────────────────────────────
const STATUS_CONFIG: Record<
  string,
  { label: string; bg: string; text: string; dot: string }
> = {
  hot: {
    label: "Hot",
    bg: "bg-red-50",
    text: "text-red-600",
    dot: "bg-red-500",
  },
  warm: {
    label: "Warm",
    bg: "bg-amber-50",
    text: "text-amber-600",
    dot: "bg-amber-400",
  },
  cold: {
    label: "Cold",
    bg: "bg-blue-50",
    text: "text-blue-600",
    dot: "bg-blue-400",
  },
  new: {
    label: "New",
    bg: "bg-gray-100",
    text: "text-gray-600",
    dot: "bg-gray-400",
  },
  qualified: {
    label: "Qualified",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    dot: "bg-emerald-500",
  },
  disqualified: {
    label: "Disqualified",
    bg: "bg-zinc-100",
    text: "text-zinc-500",
    dot: "bg-zinc-400",
  },
  callback_requested: {
    label: "Callback",
    bg: "bg-purple-50",
    text: "text-purple-600",
    dot: "bg-purple-500",
  },
  stop: {
    label: "Stop",
    bg: "bg-red-100",
    text: "text-red-700",
    dot: "bg-red-600",
  },
  completed: {
    label: "Completed",
    bg: "bg-teal-50",
    text: "text-teal-700",
    dot: "bg-teal-500",
  },
  converted: {
    label: "Converted",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    dot: "bg-emerald-500",
  },
  pending: {
    label: "Pending",
    bg: "bg-gray-100",
    text: "text-gray-600",
    dot: "bg-gray-400",
  },
};

const OUTCOME_CONFIG: Record<string, { label: string; color: string }> = {
  callback_requested: { label: "Callback Requested", color: "text-purple-600" },
  interested: { label: "Interested", color: "text-emerald-600" },
  disqualified: { label: "Not Interested", color: "text-red-500" },
  unknown: { label: "No Outcome", color: "text-gray-400" },
  completed: { label: "Completed", color: "text-teal-600" },
};

const NO_CALL_STATUSES = ["stop", "completed", "dnc", "failed"];
const COUNTDOWN_SECS = 10;

function getStatusConfig(status: string | null) {
  return (
    STATUS_CONFIG[status ?? "new"] ?? {
      label: status ?? "New",
      bg: "bg-gray-100",
      text: "text-gray-600",
      dot: "bg-gray-400",
    }
  );
}
function getIntentColor(score: number | null) {
  if (!score) return "text-gray-400";
  if (score >= 75) return "text-emerald-600";
  if (score >= 50) return "text-amber-500";
  return "text-red-500";
}
function getIntentBg(score: number | null) {
  if (!score) return "bg-gray-100";
  if (score >= 75) return "bg-emerald-50";
  if (score >= 50) return "bg-amber-50";
  return "bg-red-50";
}
function formatNextCall(date: string | null) {
  if (!date) return null;
  const now = new Date();
  const diff = new Date(date).getTime() - now.getTime();
  if (diff < 0) return "Overdue";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}
function getLastOutcome(history: any[]): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  return history[history.length - 1]?.outcome ?? null;
}
function formatDate(date: string | null) {
  if (!date) return "-";
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ─── Dialer eligibility helpers ───────────────────────────────
function isCalledToday(lead: any): boolean {
  const history: any[] = lead.follow_up_history ?? [];
  if (history.length === 0) return false;
  const last = history[history.length - 1];
  if (!last?.called_at) return false;
  const today = new Date();
  const lastCall = new Date(last.called_at);
  return (
    lastCall.getFullYear() === today.getFullYear() &&
    lastCall.getMonth() === today.getMonth() &&
    lastCall.getDate() === today.getDate()
  );
}

function buildDialerQueue(leads: any[]): any[] {
  return [...leads]
    .filter((l) => {
      if (!l.phone || l.phone.trim() === "") return false;
      if (NO_CALL_STATUSES.includes(l.current_status ?? "")) return false;
      if (isCalledToday(l)) return false;
      return true;
    })
    .sort((a, b) => (b.final_intent_score ?? 0) - (a.final_intent_score ?? 0));
}

// ─── PAGINATION ───────────────────────────────────────────────
function Pagination({
  page,
  total,
  limit,
  onChange,
}: {
  page: number;
  total: number;
  limit: number;
  onChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-1 mt-4">
      <p className="text-xs text-gray-400">
        Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of{" "}
        {total}
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
          const p =
            totalPages <= 5
              ? i + 1
              : page <= 3
                ? i + 1
                : page >= totalPages - 2
                  ? totalPages - 4 + i
                  : page - 2 + i;
          return (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={`w-8 h-8 rounded-lg text-xs font-medium transition-all ${p === page ? "bg-gray-900 text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"}`}
            >
              {p}
            </button>
          );
        })}
        <button
          onClick={() => onChange(page + 1)}
          disabled={page === totalPages}
          className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── AI DIALER BANNER ─────────────────────────────────────────
function AiDialerBanner({
  phase,
  currentLead,
  nextLead,
  countdown,
  callsMade,
  totalEligible,
  onStop,
  onSkipCountdown,
}: {
  phase: DialerPhase;
  currentLead: any | null;
  nextLead: any | null;
  countdown: number;
  callsMade: number;
  totalEligible: number;
  onStop: () => void;
  onSkipCountdown: () => void;
}) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl px-5 py-4 mb-4 flex items-center justify-between gap-4">
      {/* Status */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors ${phase === "calling" ? "bg-emerald-500" : "bg-amber-500"}`}
        >
          {phase === "calling" ? (
            <PhoneCall className="w-4 h-4 text-white animate-pulse" />
          ) : (
            <Clock className="w-4 h-4 text-white" />
          )}
        </div>
        <div className="min-w-0">
          {phase === "calling" && currentLead && (
            <>
              <p className="text-sm font-semibold text-white truncate">
                Calling —{" "}
                {currentLead.shop_name || currentLead.dealer_name || "Lead"}
              </p>
              <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                <span className="flex items-center gap-1">
                  <Phone className="w-3 h-3" />
                  {currentLead.phone}
                </span>
                {currentLead.final_intent_score != null && (
                  <span className="flex items-center gap-1 text-emerald-400">
                    <TrendingUp className="w-3 h-3" /> Score{" "}
                    {currentLead.final_intent_score}
                  </span>
                )}
              </p>
            </>
          )}
          {phase === "countdown" && (
            <>
              <p className="text-sm font-semibold text-white">
                Next call in{" "}
                <span className="text-amber-400 tabular-nums">
                  {countdown}s
                </span>
              </p>
              {nextLead && (
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                  Up next:{" "}
                  {nextLead.shop_name || nextLead.dealer_name || "Lead"}
                  {nextLead.final_intent_score != null &&
                    ` · Score ${nextLead.final_intent_score}`}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="hidden md:flex flex-col items-center gap-1.5 shrink-0">
        <p className="text-xs text-gray-400 tabular-nums">
          {callsMade} / {totalEligible} calls
        </p>
        <div className="w-36 h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{
              width:
                totalEligible > 0
                  ? `${(callsMade / totalEligible) * 100}%`
                  : "0%",
            }}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        {phase === "countdown" && (
          <button
            onClick={onSkipCountdown}
            className="px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-all"
          >
            Call Now
          </button>
        )}
        <button
          onClick={onStop}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-all"
        >
          <StopCircle className="w-3.5 h-3.5" /> Stop
        </button>
      </div>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────
export default function LeadsUnifiedPage() {
  const [tab, setTab] = useState<Tab>("leads");
  const [search, setSearch] = useState("");

  const [leads, setLeads] = useState<any[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadsPage, setLeadsPage] = useState(1);
  const [leadsLoading, setLeadsLoading] = useState(false);

  const [scraperLeads, setScraperLeads] = useState<any[]>([]);
  const [scraperTotal, setScraperTotal] = useState(0);
  const [scraperPage, setScraperPage] = useState(1);
  const [scraperLoading, setScraperLoading] = useState(false);

  const [convertedLeads, setConvertedLeads] = useState<any[]>([]);
  const [convertedTotal, setConvertedTotal] = useState(0);
  const [convertedPage, setConvertedPage] = useState(1);
  const [convertedLoading, setConvertedLoading] = useState(false);

  // ─── AI Dialer state ─────────────────────────────────────────
  const [dialerOn, setDialerOn] = useState(false);
  const [dialerPhase, setDialerPhase] = useState<DialerPhase>("idle");
  const [dialerQueue, setDialerQueue] = useState<any[]>([]);
  const [dialerIndex, setDialerIndex] = useState(0);
  const [dialerCallsMade, setDialerCallsMade] = useState(0);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECS);

  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const stopRef = useRef(false);
  // keep latest queue/index accessible inside interval callbacks
  const queueRef = useRef<any[]>([]);
  const indexRef = useRef(0);

  const LIMIT = 10;

  // ─── Fetch functions ──────────────────────────────────────────
  const fetchLeads = useCallback(async (page: number, q: string) => {
    setLeadsLoading(true);
    try {
      const res = await fetch(
        `/api/dealer-leads?page=${page}&limit=${LIMIT}&search=${encodeURIComponent(q)}`,
      );
      const data = await res.json();
      if (data.success) {
        setLeads(data.leads);
        setLeadsTotal(data.total);
      }
    } finally {
      setLeadsLoading(false);
    }
  }, []);

  const fetchScraperLeads = useCallback(async (page: number, q: string) => {
    setScraperLoading(true);
    try {
      const res = await fetch(
        `/api/scraper-leads?page=${page}&limit=${LIMIT}&search=${encodeURIComponent(q)}`,
      );
      const data = await res.json();
      if (data.success) {
        setScraperLeads(data.leads);
        setScraperTotal(data.total);
      }
    } finally {
      setScraperLoading(false);
    }
  }, []);

  const fetchConvertedLeads = useCallback(async (page: number, q: string) => {
    setConvertedLoading(true);
    try {
      const res = await fetch(
        `/api/scraper-leads/converted?page=${page}&limit=${LIMIT}&search=${encodeURIComponent(q)}`,
      );
      const data = await res.json();
      if (data.success) {
        setConvertedLeads(data.leads);
        setConvertedTotal(data.total);
      }
    } finally {
      setConvertedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "scraper") fetchScraperLeads(scraperPage, search);
    if (tab === "leads") fetchLeads(leadsPage, search);
    if (tab === "converted") fetchConvertedLeads(convertedPage, search);
  }, [tab, leadsPage, scraperPage, convertedPage, search]);

  const handleSearch = (v: string) => {
    setSearch(v);
    setLeadsPage(1);
    setScraperPage(1);
    setConvertedPage(1);
  };

  // ─── Dialer core ──────────────────────────────────────────────
  const triggerCall = useCallback(async (lead: any) => {
    setDialerPhase("calling");
    try {
      await fetch("/api/bolna/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: lead.phone, leadId: lead.id }),
      });
    } catch (e) {
      console.error("Dialer call error", e);
    }
  }, []);

  const startCountdownTo = useCallback(
    (nextIdx: number) => {
      const queue = queueRef.current;
      if (stopRef.current || nextIdx >= queue.length) {
        setDialerPhase("idle");
        setDialerOn(false);
        return;
      }
      setDialerPhase("countdown");
      setDialerIndex(nextIdx);
      indexRef.current = nextIdx;
      setCountdown(COUNTDOWN_SECS);

      let secs = COUNTDOWN_SECS;
      if (countdownRef.current) clearInterval(countdownRef.current);
      countdownRef.current = setInterval(() => {
        secs -= 1;
        setCountdown(secs);
        if (secs <= 0) {
          clearInterval(countdownRef.current!);
          if (stopRef.current) return;
          const idx = indexRef.current;
          triggerCall(queueRef.current[idx]).then(() => {
            setDialerCallsMade((c) => c + 1);
            startCountdownTo(idx + 1);
          });
        }
      }, 1000);
    },
    [triggerCall],
  );

  // ─── Turn ON ──────────────────────────────────────────────────
  const handleDialerOn = useCallback(async () => {
    const res = await fetch(`/api/dealer-leads?page=1&limit=500&search=`);
    const data = await res.json();
    if (!data.success) return;

    const queue = buildDialerQueue(data.leads);
    if (queue.length === 0) return;

    stopRef.current = false;
    queueRef.current = queue;
    setDialerQueue(queue);
    setDialerIndex(0);
    setDialerCallsMade(0);
    setDialerOn(true);
    setDialerPhase("calling");

    // Start the session on the server with the full queue
    await fetch("/api/ai-dialer/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queueIds: queue.map((l) => l.id) }),
    });

    // Trigger first call
    await fetch("/api/bolna/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: queue[0].phone, leadId: queue[0].id }),
    });

    setDialerCallsMade(1);
  }, []);

  // ─── Turn OFF ─────────────────────────────────────────────────
  const handleDialerOff = useCallback(() => {
    stopRef.current = true;
    if (countdownRef.current) clearInterval(countdownRef.current);
    setDialerOn(false);
    setDialerPhase("idle");
    setDialerQueue([]);
    setDialerIndex(0);
    setDialerCallsMade(0);
    // Stop server session
    fetch("/api/ai-dialer/stop", { method: "POST" });
  }, []);

  // ─── Skip countdown → call immediately ───────────────────────
  const handleSkipCountdown = useCallback(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (stopRef.current) return;
    const idx = indexRef.current;
    if (idx >= queueRef.current.length) return;
    triggerCall(queueRef.current[idx]).then(() => {
      setDialerCallsMade((c) => c + 1);
      startCountdownTo(idx + 1);
    });
  }, [triggerCall, startCountdownTo]);

  // cleanup
  useEffect(
    () => () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    },
    [],
  );

  const stats = {
    total: leadsTotal,
    hot: leads.filter((l) => l.current_status === "hot").length,
    warm: leads.filter((l) => l.current_status === "warm").length,
    qualified: leads.filter((l) => l.current_status === "qualified").length,
    scheduled: leads.filter((l) => l.next_call_at).length,
  };

  const currentDialerLead = dialerQueue[dialerIndex] ?? null;
  const nextDialerLead = dialerQueue[dialerIndex + 1] ?? null;

  return (
    <div className="max-w-6xl mx-auto py-8 px-6 min-h-screen bg-gray-50">
      {/* HEADER */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            Leads
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage dealer leads and track their interest
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* AI DIALER TOGGLE — leads tab only */}
          {tab === "leads" && (
            <button
              onClick={dialerOn ? handleDialerOff : handleDialerOn}
              className="flex items-center gap-3 px-4 py-2.5 bg-white border border-gray-200 rounded-xl hover:border-gray-300 transition-all shadow-sm group"
            >
              {/* Toggle pill */}
              <div
                className={`relative w-9 h-5 rounded-full transition-colors duration-300 ${dialerOn ? "bg-emerald-500" : "bg-gray-200"}`}
              >
                <div
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300 ${dialerOn ? "translate-x-4" : "translate-x-0"}`}
                />
              </div>

              {/* Label */}
              <span className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
                <Zap
                  className={`w-3.5 h-3.5 transition-colors ${dialerOn ? "text-emerald-500" : "text-gray-400"}`}
                />
                AI Dialer
              </span>

              {/* Status badge */}
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full transition-colors ${
                  dialerOn
                    ? "bg-emerald-50 text-emerald-600"
                    : "bg-gray-100 text-gray-400"
                }`}
              >
                {dialerOn ? "ON" : "OFF"}
              </span>
            </button>
          )}
          <Link href="/leads/new">
            <button className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 transition-all">
              <Plus className="w-4 h-4" /> New Lead
            </button>
          </Link>
        </div>
      </div>

      {/* STATS ROW */}
      {tab === "leads" && (
        <div className="grid grid-cols-5 gap-3 mb-6">
          {[
            { label: "Total Leads", value: leadsTotal, color: "text-gray-900" },
            { label: "Hot", value: stats.hot, color: "text-red-600" },
            { label: "Warm", value: stats.warm, color: "text-amber-600" },
            {
              label: "Qualified",
              value: stats.qualified,
              color: "text-emerald-600",
            },
            {
              label: "Scheduled",
              value: stats.scheduled,
              color: "text-purple-600",
            },
          ].map(({ label, value, color }) => (
            <div
              key={label}
              className="bg-white border border-gray-200 rounded-xl p-4"
            >
              <p className="text-xs text-gray-500 mb-1">{label}</p>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* TABS + SEARCH */}
      <div className="flex items-center justify-between mb-4 gap-4">
        <div className="flex items-center bg-white border border-gray-200 rounded-xl p-1 gap-1">
          {(
            [
              { key: "scraper", label: "Scraper Leads" },
              { key: "leads", label: "Leads" },
              { key: "converted", label: "My Converted Leads" },
            ] as { key: Tab; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                tab === key
                  ? "bg-gray-900 text-white shadow-sm"
                  : "text-gray-500 hover:text-gray-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search by name, phone, city..."
            className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl bg-white outline-none focus:border-gray-400 w-64"
          />
        </div>
      </div>

      {/* ── TAB: DEALER LEADS ── */}
      {tab === "leads" && (
        <div>
          {/* AI DIALER LIVE BANNER */}
          {dialerOn && dialerPhase !== "idle" && (
            <AiDialerBanner
              phase={dialerPhase}
              currentLead={currentDialerLead}
              nextLead={nextDialerLead}
              countdown={countdown}
              callsMade={dialerCallsMade}
              totalEligible={dialerQueue.length}
              onStop={handleDialerOff}
              onSkipCountdown={handleSkipCountdown}
            />
          )}

          {leadsLoading ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="space-y-2">
                {leads.map((lead) => {
                  const statusCfg = getStatusConfig(lead.current_status);
                  const lastOutcome = getLastOutcome(
                    lead.follow_up_history ?? [],
                  );
                  const outcomeCfg = lastOutcome
                    ? OUTCOME_CONFIG[lastOutcome]
                    : null;
                  const nextCallLabel = formatNextCall(lead.next_call_at);
                  const isDisabled = NO_CALL_STATUSES.includes(
                    lead.current_status ?? "",
                  );
                  const intentScore = lead.final_intent_score;
                  const isBeingCalled =
                    dialerOn &&
                    dialerPhase === "calling" &&
                    currentDialerLead?.id === lead.id;
                  const isUpNext =
                    dialerOn &&
                    dialerPhase === "countdown" &&
                    currentDialerLead?.id === lead.id;

                  return (
                    <div
                      key={lead.id}
                      className={`bg-white border rounded-xl px-5 py-4 transition-all duration-150 ${
                        isBeingCalled
                          ? "border-emerald-400 ring-1 ring-emerald-300 shadow-sm"
                          : isUpNext
                            ? "border-amber-300 ring-1 ring-amber-200"
                            : "border-gray-200 hover:border-gray-300 hover:shadow-sm"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        {/* LEFT */}
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isBeingCalled ? "bg-emerald-50" : isUpNext ? "bg-amber-50" : "bg-gray-100"}`}
                          >
                            {isBeingCalled ? (
                              <PhoneCall className="w-4 h-4 text-emerald-600 animate-pulse" />
                            ) : (
                              <Store className="w-4 h-4 text-gray-500" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold text-gray-900 truncate">
                                {lead.shop_name || "Unnamed Shop"}
                              </p>
                              {isBeingCalled && (
                                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-600 animate-pulse shrink-0">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{" "}
                                  Calling…
                                </span>
                              )}
                              {isUpNext && (
                                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600 shrink-0">
                                  <Clock className="w-3 h-3" /> Up next in{" "}
                                  {countdown}s
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="flex items-center gap-1 text-xs text-gray-500">
                                <User className="w-3 h-3" />
                                {lead.dealer_name || "Unknown"}
                              </span>
                              <span className="text-gray-300">·</span>
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <MapPin className="w-3 h-3" />
                                {lead.location || "-"}
                              </span>
                              <span className="text-gray-300">·</span>
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <Phone className="w-3 h-3" />
                                {lead.phone || "-"}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* CENTER */}
                        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                          <span
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`}
                            />
                            {statusCfg.label}
                          </span>
                          {intentScore != null && (
                            <span
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${getIntentBg(intentScore)} ${getIntentColor(intentScore)}`}
                            >
                              <TrendingUp className="w-3 h-3" />
                              {intentScore}
                            </span>
                          )}
                          {(lead.total_attempts ?? 0) > 0 && (
                            <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                              <RefreshCw className="w-3 h-3" />
                              {lead.total_attempts}x
                            </span>
                          )}
                          {outcomeCfg && (
                            <span
                              className={`text-xs font-medium ${outcomeCfg.color} hidden lg:block`}
                            >
                              {outcomeCfg.label}
                            </span>
                          )}
                          {nextCallLabel && (
                            <span
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${nextCallLabel === "Overdue" ? "bg-red-50 text-red-600" : "bg-purple-50 text-purple-600"}`}
                            >
                              <Clock className="w-3 h-3" />
                              {nextCallLabel}
                            </span>
                          )}
                        </div>

                        {/* RIGHT */}
                        <div className="flex items-center gap-2 shrink-0">
                          {isDisabled && (
                            <span className="flex items-center gap-1 text-xs text-gray-400">
                              <AlertCircle className="w-3 h-3" /> No calls
                            </span>
                          )}
                          <CallButton
                            leadId={lead.id}
                            phone={lead.phone ?? ""}
                            disabled={isDisabled || !lead.phone}
                          />
                          <Link href={`/leads/${lead.id}`}>
                            <button className="px-3 py-1.5 text-xs font-medium border border-gray-200 rounded-lg hover:bg-gray-50 transition-all">
                              View
                            </button>
                          </Link>
                          <Link href={`/leads/${lead.id}/edit`}>
                            <button className="px-3 py-1.5 text-xs font-medium text-gray-500 rounded-lg hover:bg-gray-50 transition-all">
                              Edit
                            </button>
                          </Link>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {leads.length === 0 && (
                <EmptyState label="No dealer leads found" />
              )}
              <Pagination
                page={leadsPage}
                total={leadsTotal}
                limit={LIMIT}
                onChange={setLeadsPage}
              />
            </>
          )}
        </div>
      )}

      {/* ── TAB: SCRAPER LEADS ── */}
      {tab === "scraper" && (
        <div>
          {scraperLoading ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="space-y-2">
                {[...scraperLeads]
                  .sort((a, b) => {
                    const aHas = !!a.phone && a.phone.trim() !== "";
                    const bHas = !!b.phone && b.phone.trim() !== "";
                    if (aHas && !bHas) return -1;
                    if (!aHas && bHas) return 1;
                    return 0;
                  })
                  .map((lead) => {
                    const statusCfg = getStatusConfig(lead.status);
                    return (
                      <div
                        key={lead.id}
                        className="bg-white border border-gray-200 rounded-xl px-5 py-4 hover:border-gray-300 hover:shadow-sm transition-all duration-150"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                              <User className="w-4 h-4 text-gray-500" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-900 truncate">
                                {lead.name || "Unknown"}
                              </p>
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                <span className="flex items-center gap-1 text-xs text-gray-400">
                                  <Phone className="w-3 h-3" />
                                  {lead.phone || "-"}
                                </span>
                                <span className="text-gray-300">·</span>
                                <span className="flex items-center gap-1 text-xs text-gray-400">
                                  <MapPin className="w-3 h-3" />
                                  {lead.city || "-"}
                                </span>
                                <span className="text-gray-300">·</span>
                                <span className="flex items-center gap-1 text-xs text-gray-400">
                                  <Globe className="w-3 h-3" />
                                  {lead.source || "-"}
                                </span>
                                <span className="text-gray-300">·</span>
                                <span className="flex items-center gap-1 text-xs text-gray-400">
                                  <Calendar className="w-3 h-3" />
                                  {formatDate(lead.created_at)}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span
                              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}
                            >
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`}
                              />
                              {statusCfg.label}
                            </span>
                            <Link
                              href={`/leads/new?from_scraped=${lead.id}&name=${encodeURIComponent(lead.name || "")}&phone=${encodeURIComponent(lead.phone || "")}`}
                            >
                              <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition-all">
                                <Plus className="w-3 h-3" /> Convert
                              </button>
                            </Link>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
              {scraperLeads.length === 0 && (
                <EmptyState label="No scraper leads found" />
              )}
              <Pagination
                page={scraperPage}
                total={scraperTotal}
                limit={LIMIT}
                onChange={setScraperPage}
              />
            </>
          )}
        </div>
      )}

      {/* ── TAB: CONVERTED LEADS ── */}
      {tab === "converted" && (
        <div>
          {convertedLoading ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="space-y-2">
                {convertedLeads.map((lead) => {
                  const statusCfg = getStatusConfig(lead.current_status);
                  const intentScore = lead.final_intent_score;
                  return (
                    <div
                      key={lead.id}
                      className="bg-white border border-gray-200 rounded-xl px-5 py-4 hover:border-gray-300 hover:shadow-sm transition-all duration-150"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
                            <Store className="w-4 h-4 text-emerald-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900 truncate">
                              {lead.shop_name || "Unnamed Shop"}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="flex items-center gap-1 text-xs text-gray-500">
                                <User className="w-3 h-3" />
                                {lead.dealer_name || "Unknown"}
                              </span>
                              <span className="text-gray-300">·</span>
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <MapPin className="w-3 h-3" />
                                {lead.location || "-"}
                              </span>
                              <span className="text-gray-300">·</span>
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <Phone className="w-3 h-3" />
                                {lead.phone || "-"}
                              </span>
                              <span className="text-gray-300">·</span>
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <Calendar className="w-3 h-3" />
                                {formatDate(lead.created_at)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`}
                            />
                            {statusCfg.label}
                          </span>
                          {intentScore != null && (
                            <span
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${getIntentBg(intentScore)} ${getIntentColor(intentScore)}`}
                            >
                              <TrendingUp className="w-3 h-3" />
                              {intentScore}
                            </span>
                          )}
                          <Link href={`/leads/${lead.id}`}>
                            <button className="px-3 py-1.5 text-xs font-medium border border-gray-200 rounded-lg hover:bg-gray-50 transition-all">
                              View
                            </button>
                          </Link>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {convertedLeads.length === 0 && (
                <EmptyState label="No converted leads yet" />
              )}
              <Pagination
                page={convertedPage}
                total={convertedTotal}
                limit={LIMIT}
                onChange={setConvertedPage}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="bg-white border border-gray-200 rounded-xl px-5 py-4 animate-pulse"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gray-100" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-gray-100 rounded w-40" />
              <div className="h-2.5 bg-gray-100 rounded w-64" />
            </div>
            <div className="h-6 w-20 bg-gray-100 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mb-3">
        <Store className="w-6 h-6 text-gray-400" />
      </div>
      <p className="text-sm font-medium text-gray-600">{label}</p>
    </div>
  );
}
