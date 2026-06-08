// Slide-in right drawer that shows the full transcript of an AI call placed
// during a campaign, plus the analyzer's 6-dimension intent breakdown and a
// summary. Driven by /api/ai-dialer/campaigns/[id]/leads/[leadId]/transcript.
//
// Layout is tabbed (Overview / Transcription / Details) so the transcript
// always has full vertical space — that's the primary thing reviewers come
// here to read. Chat bubbles render any language (Hindi included) without
// per-language hacks because we just render the raw turn text.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Phone,
  MapPin,
  Clock,
  PlayCircle,
  Play,
  Pause,
  Sparkles,
  AlertCircle,
  Loader2,
  Bot,
  User as UserIcon,
  History,
  RotateCcw,
  CheckCircle2,
} from "lucide-react";
// Import the thresholds module directly (not the scoring barrel) so the client
// bundle doesn't pull in zod / the scoring engine.
import { INTENT_THRESHOLDS } from "@/lib/ai/scoring/thresholds";

type SubScores = {
  next_step_commitment: number;
  urgency_signals: number;
  product_curiosity: number;
  need_acknowledgment: number;
  objection_quality: number;
  engagement_depth: number;
};

// The truthful per-point breakdown from the deterministic scorer. Contributions
// (positive signal points + any negative cap line) sum exactly to intentScore.
type ScoreBreakdownItem = {
  signal: string;
  label: string;
  contribution: number;
  evidence: string;
};

// Raw extracted signals behind the score (ai_call_logs.signals). Only the
// leveled signals drive the deep-mode correction dropdowns; the rest is carried
// through untouched when a reviewer submits a per-signal correction. Levels are
// declared locally (not imported from signals.ts) to keep zod / the scoring
// engine out of the client bundle.
type LeveledSignal = { level: string; evidence?: string };
type ClientSignals = {
  budget?: LeveledSignal;
  authority?: LeveledSignal;
  need?: LeveledSignal;
  timeline?: LeveledSignal;
  engagement?: LeveledSignal;
  curiosity?: LeveledSignal;
  objection_quality?: LeveledSignal;
  [k: string]: unknown;
};

const SIGNAL_LEVELS = ["unknown", "none", "weak", "moderate", "strong"];
const AUTHORITY_LEVELS = ["unknown", "decision_maker", "influencer", "not_decision_maker"];
const TIMELINE_LEVELS = ["unknown", "now", "this_week", "this_month", "later", "none"];
const OBJECTION_LEVELS = ["unknown", "none", "low", "substantive"];

// The seven leveled signals a reviewer can correct in deep mode, with their
// allowed level sets. Mirrors signals.ts (kept in sync by hand to avoid the
// zod import on the client).
const CORRECTABLE_SIGNALS: Array<{ key: keyof ClientSignals; label: string; levels: string[] }> = [
  { key: "need", label: "Need", levels: SIGNAL_LEVELS },
  { key: "budget", label: "Budget / Financing", levels: SIGNAL_LEVELS },
  { key: "engagement", label: "Engagement", levels: SIGNAL_LEVELS },
  { key: "curiosity", label: "Curiosity", levels: SIGNAL_LEVELS },
  { key: "timeline", label: "Timeline", levels: TIMELINE_LEVELS },
  { key: "objection_quality", label: "Objection Quality", levels: OBJECTION_LEVELS },
  { key: "authority", label: "Authority", levels: AUTHORITY_LEVELS },
];

const LEAD_STATUS_OPTIONS = ["qualified", "warm", "cold", "disqualified"] as const;

// Raw conversation turn shapes vary by provider. Bolna stores objects with
// `role` + `content` (or `transcript`/`message`); ElevenLabs uses `role` +
// `message`. We coerce to a single internal shape downstream.
type RawTurn = {
  role?: string;
  speaker?: string;
  from?: string;
  content?: string;
  message?: string;
  text?: string;
  transcript?: string;
  time_in_call_secs?: number;
  timestamp?: string | number;
  start_time?: number;
};

// One dialer attempt for this lead, across the original + every recall
// campaign. Ordered chronologically by the transcript route.
type Attempt = {
  attempt: number;
  campaignId: string;
  campaignName: string | null;
  isRecall: boolean;
  status: string;
  callOutcome: string | null;
  intentScore: number | null;
  startedAt: string | null;
  completedAt: string | null;
  converted: boolean;
  isCurrent: boolean;
  // Provider call id + a playable recording URL for THIS attempt (stored Supabase
  // link, or the self-healing /api/ai-dialer/recording proxy). null when the
  // attempt has no call id (no-answer/failed) and thus no recording.
  callId: string | null;
  recordingUrl: string | null;
};

type TranscriptPayload = {
  leadName: string | null;
  phone: string | null;
  state: string | null;
  city: string | null;
  campaignLeadStatus: string;
  callOutcome: string | null;
  startedAt: string | null;
  completedAt: string | null;
  bolnaCallId: string | null;
  callId: string | null;
  signals: ClientSignals | null;
  intentScore: number | null;
  intentReason: string | null;
  callDuration: number | null;
  recordingUrl: string | null;
  summary: string | null;
  transcript: string | null;
  conversation: RawTurn[] | null;
  provider: string | null;
  callStatus: string | null;
  nextAction: string | null;
  analysis: SubScores | null;
  scoreBreakdown: ScoreBreakdownItem[] | null;
  scoringVersion: string | null;
  attempts: Attempt[] | null;
  convertedOnAttempt: number | null;
};

type ChatTurn = {
  role: "assistant" | "user";
  text: string;
  // seconds-into-call (for the small caption under each bubble)
  tSec: number | null;
};

const SUBSCORE_LABELS: Array<{ key: keyof SubScores; label: string; hint: string }> = [
  { key: "urgency_signals", label: "Urgency", hint: "How quickly the dealer wants to act" },
  { key: "next_step_commitment", label: "Commitment", hint: "Concrete next step agreed by dealer" },
  { key: "product_curiosity", label: "Curiosity", hint: "Questions about the product" },
  { key: "need_acknowledgment", label: "Need", hint: "Acknowledgment of a relevant need" },
  { key: "objection_quality", label: "Objection", hint: "Depth of pushback (low = blanket no, high = specific concern)" },
  { key: "engagement_depth", label: "Engagement", hint: "Overall conversation engagement" },
];

// Coerces a turn's "speaker" field across providers into our two-bucket
// model. Anything that isn't clearly the human side is treated as the AI.
function normalizeRole(raw: string | undefined): "assistant" | "user" {
  if (!raw) return "assistant";
  const r = raw.toLowerCase();
  if (
    r === "user" ||
    r === "human" ||
    r === "dealer" ||
    r === "customer" ||
    r === "caller"
  ) {
    return "user";
  }
  return "assistant";
}

function pickTime(t: RawTurn): number | null {
  if (typeof t.time_in_call_secs === "number") return t.time_in_call_secs;
  if (typeof t.start_time === "number") return t.start_time;
  if (typeof t.timestamp === "number") return t.timestamp;
  return null;
}

function pickText(t: RawTurn): string {
  return (t.content || t.message || t.text || t.transcript || "").trim();
}

// Build the chat turns. The structured `conversation` array is the source of
// truth when present (gives us timestamps + cleaner alignment). Fallback is
// the plain transcript string with `Role:` line prefixes.
function buildTurns(
  conversation: RawTurn[] | null,
  transcript: string | null,
): ChatTurn[] {
  if (Array.isArray(conversation) && conversation.length > 0) {
    return conversation
      .map((t) => ({
        role: normalizeRole(t.role || t.speaker || t.from),
        text: pickText(t),
        tSec: pickTime(t),
      }))
      .filter((t) => t.text);
  }

  if (!transcript) return [];
  const turns: ChatTurn[] = [];
  for (const line of transcript.split("\n")) {
    const match = line.match(
      /^(assistant|user|ai|human|agent|dealer|customer|caller|bot):\s*(.*)/i,
    );
    if (match) {
      const text = match[2].trim();
      if (!text) continue;
      turns.push({
        role: normalizeRole(match[1]),
        text,
        tSec: null,
      });
      continue;
    }
    const stripped = line.trim();
    if (!stripped) continue;
    // Untagged line — fold into the previous bubble if there is one, else
    // attribute to the assistant.
    if (turns.length > 0) {
      turns[turns.length - 1] = {
        ...turns[turns.length - 1],
        text: `${turns[turns.length - 1].text}\n${stripped}`,
      };
    } else {
      turns.push({ role: "assistant", text: stripped, tSec: null });
    }
  }
  return turns;
}

function fmtDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function fmtClock(seconds: number | null): string | null {
  if (seconds == null || seconds < 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function scoreToneClass(score: number | null): {
  ring: string;
  text: string;
  bar: string;
  bg: string;
} {
  if (score == null)
    return { ring: "border-gray-200", text: "text-gray-500", bar: "bg-gray-400", bg: "bg-gray-50" };
  if (score >= INTENT_THRESHOLDS.QUALIFIED)
    return { ring: "border-emerald-300", text: "text-emerald-700", bar: "bg-emerald-500", bg: "bg-emerald-50" };
  if (score >= INTENT_THRESHOLDS.WARM)
    return { ring: "border-amber-300", text: "text-amber-700", bar: "bg-amber-500", bg: "bg-amber-50" };
  return { ring: "border-rose-300", text: "text-rose-700", bar: "bg-rose-500", bg: "bg-rose-50" };
}

// One row of the truthful breakdown: label, signed point contribution, a bar
// sized by magnitude (out of the 100-point scale), and the supporting evidence.
function BreakdownRow({ item }: { item: ScoreBreakdownItem }) {
  const positive = item.contribution >= 0;
  const pct = Math.min(100, Math.abs(item.contribution));
  const barTone = positive ? "bg-emerald-500" : "bg-rose-400";
  const valTone = positive ? "text-emerald-700" : "text-rose-700";
  const showEvidence = item.evidence && item.evidence !== "unknown";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-gray-700">{item.label}</span>
        <span className={`text-[11px] tabular-nums font-mono ${valTone}`}>
          {positive ? "+" : "−"}
          {Math.abs(item.contribution)}
        </span>
      </div>
      <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${barTone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {showEvidence && (
        <p className="text-[10px] text-gray-400 leading-snug truncate" title={item.evidence}>
          {item.evidence}
        </p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const m: Record<string, { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "bg-gray-100 text-gray-700" },
    calling: { label: "Calling", cls: "bg-blue-100 text-blue-700" },
    completed: { label: "Completed", cls: "bg-emerald-100 text-emerald-700" },
    failed: { label: "Failed", cls: "bg-rose-100 text-rose-700" },
  };
  const { label, cls } = m[status] ?? { label: status, cls: "bg-gray-100 text-gray-700" };
  return (
    <span
      className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full ${cls}`}
    >
      {label}
    </span>
  );
}

function SubScoreBar({ label, hint, value }: { label: string; hint: string; value: number }) {
  const pct = Math.max(0, Math.min(10, value)) * 10;
  const tone = value >= 7 ? "bg-emerald-500" : value >= 4 ? "bg-amber-500" : "bg-rose-400";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-gray-700" title={hint}>
          {label}
        </span>
        <span className="text-[11px] tabular-nums font-mono text-gray-500">{value}/10</span>
      </div>
      <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

type TabKey = "overview" | "attempts" | "transcript" | "details";

export function CampaignLeadTranscriptDrawer({
  campaignId,
  leadId,
  onClose,
}: {
  campaignId: string;
  leadId: string | null;
  onClose: () => void;
}) {
  const open = leadId != null;
  const [tab, setTab] = useState<TabKey>("transcript");

  // Reset to Transcription tab whenever a new lead is opened so reviewers
  // land on the most-asked-for content immediately.
  useEffect(() => {
    if (open) setTab("transcript");
  }, [open, leadId]);

  // ESC closes the drawer.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const { data, isLoading, isError, error } = useQuery<TranscriptPayload>({
    enabled: open,
    queryKey: ["campaign-lead-transcript", campaignId, leadId],
    queryFn: async () => {
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/leads/${leadId}/transcript`,
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Failed to load");
      return json.data as TranscriptPayload;
    },
    refetchInterval: (q) => {
      const d = q.state.data as TranscriptPayload | undefined;
      return d?.campaignLeadStatus === "calling" || d?.campaignLeadStatus === "pending"
        ? 4000
        : false;
    },
  });

  const turns = useMemo(
    () => buildTurns(data?.conversation ?? null, data?.transcript ?? null),
    [data?.conversation, data?.transcript],
  );

  if (!open) return null;

  const status = data?.campaignLeadStatus ?? "pending";
  const hasContent = turns.length > 0;
  const attemptCount = data?.attempts?.length ?? 0;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-gray-900/40 backdrop-blur-[2px] cursor-default"
      />

      <aside
        className="absolute right-0 top-0 h-full w-full max-w-[760px] bg-white shadow-2xl flex flex-col"
        style={{ animation: "slideIn 200ms ease-out" }}
      >
        {/* Header */}
        <div className="border-b border-gray-100 px-6 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-gray-900 truncate">
                {data?.leadName ?? "Lead"}
              </h2>
              <StatusPill status={status} />
            </div>
            <div className="mt-1 flex items-center gap-3 text-xs text-gray-500 flex-wrap">
              {data?.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone className="w-3 h-3" />
                  {data.phone}
                </span>
              )}
              {(data?.city || data?.state) && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {[data?.city, data?.state].filter(Boolean).join(", ")}
                </span>
              )}
              {data?.callDuration != null && data.callDuration > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {fmtDuration(data.callDuration)}
                </span>
              )}
              {data?.provider && (
                <span className="inline-flex items-center gap-1 uppercase tracking-wide">
                  <Bot className="w-3 h-3" />
                  {data.provider}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 p-1"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-100 px-6 flex items-center gap-6 text-sm">
          <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}>
            Overview
          </TabBtn>
          <TabBtn active={tab === "attempts"} onClick={() => setTab("attempts")}>
            Attempts
            {attemptCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center text-[10px] tabular-nums font-mono bg-gray-100 text-gray-600 rounded-full px-1.5 py-px">
                {attemptCount}
              </span>
            )}
          </TabBtn>
          <TabBtn active={tab === "transcript"} onClick={() => setTab("transcript")}>
            Transcription
            {hasContent && (
              <span className="ml-1.5 inline-flex items-center justify-center text-[10px] tabular-nums font-mono bg-gray-100 text-gray-600 rounded-full px-1.5 py-px">
                {turns.length}
              </span>
            )}
          </TabBtn>
          <TabBtn active={tab === "details"} onClick={() => setTab("details")}>
            Details
          </TabBtn>
        </div>

        {/* Inline recording player — visible on every tab once a call has a
            recording. recordingUrl is the lead's latest call across campaigns. */}
        {data?.recordingUrl && (
          <RecordingPlayer key={data.recordingUrl} url={data.recordingUrl} />
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-gray-50/50">
          {isLoading ? (
            <div className="py-24 flex items-center justify-center text-gray-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading transcript…
            </div>
          ) : isError ? (
            <div className="px-6 py-12 text-center text-sm text-rose-600">
              <AlertCircle className="w-5 h-5 mx-auto mb-2" />
              {(error as Error)?.message ?? "Failed to load transcript"}
            </div>
          ) : !data ? null : tab === "attempts" ? (
            // Attempts always renders its own timeline — even for a lead that's
            // pending/calling in THIS campaign but was dialed in earlier ones.
            <AttemptsTab data={data} />
          ) : status === "pending" ? (
            <EmptyState
              icon={<Clock className="w-8 h-8 text-gray-300" />}
              title="Call not yet placed"
              body="This lead is waiting in the queue. The drawer will update automatically when the call begins."
            />
          ) : status === "calling" ? (
            <EmptyState
              icon={
                <span className="relative flex h-8 w-8 items-center justify-center">
                  <span className="absolute inline-flex h-8 w-8 rounded-full bg-blue-200 opacity-75 animate-ping" />
                  <Phone className="relative w-5 h-5 text-blue-600" />
                </span>
              }
              title="Call in progress…"
              body="We'll show the transcript and intent breakdown the moment the call ends."
            />
          ) : tab === "transcript" ? (
            <TranscriptTab turns={turns} data={data} />
          ) : tab === "overview" ? (
            <OverviewTab data={data} campaignId={campaignId} leadId={leadId} />
          ) : (
            <DetailsTab data={data} />
          )}
        </div>
      </aside>

      <style jsx>{`
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0.6;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

// Slim audio player for a call recording. `url` is either a public Supabase
// Storage link (already re-hosted) or the self-healing
// /api/ai-dialer/recording/[callId] proxy, which 302-redirects to that same
// public link after re-hosting an ElevenLabs call's audio on first hit. Either
// way it plays in-page with a plain <audio> element.
// Two layouts: the default full-width top strip (latest call, on every tab) and
// `compact` — an in-card variant rendered per attempt in the Attempts timeline.
// Rendered with key={url} by the parent, so a new lead/recording remounts this
// fresh — no reset effect needed, all transport state starts clean. Each instance
// owns its own <audio>, so per-attempt players play independently.
function RecordingPlayer({
  url,
  compact = false,
}: {
  url: string;
  compact?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [ready, setReady] = useState(false);
  const [errored, setErrored] = useState(false);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => setErrored(true));
    } else {
      el.pause();
    }
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current;
    const t = Number(e.target.value);
    if (el) el.currentTime = t;
    setCur(t);
  }

  if (errored) {
    return (
      <div
        className={
          compact
            ? "mt-2 rounded-lg border border-gray-200 bg-gray-50/80 px-3 py-2 flex items-center gap-2 text-xs text-gray-400"
            : "border-b border-gray-100 px-6 py-2.5 flex items-center gap-2 text-xs text-gray-400 bg-gray-50/60"
        }
      >
        <AlertCircle className="w-3.5 h-3.5" />
        Recording unavailable
      </div>
    );
  }

  return (
    <div
      className={
        compact
          ? "mt-2 rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2 flex items-center gap-3"
          : "border-b border-gray-100 px-6 py-2.5 flex items-center gap-3 bg-gradient-to-r from-emerald-50/70 to-white"
      }
    >
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setDur(Number.isFinite(d) ? d : 0);
          setReady(true);
        }}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCur(0);
        }}
        onError={() => setErrored(true)}
      />
      <button
        type="button"
        onClick={toggle}
        disabled={!ready}
        aria-label={playing ? "Pause recording" : "Play recording"}
        className={`flex-shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white flex items-center justify-center shadow-sm transition-colors ${
          compact ? "w-8 h-8" : "w-9 h-9"
        }`}
      >
        {playing ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4 ml-0.5" />
        )}
      </button>
      {!compact && (
        <span className="hidden sm:inline text-[10px] uppercase tracking-wider text-emerald-700 font-semibold">
          Recording
        </span>
      )}
      <input
        type="range"
        min={0}
        max={dur || 0}
        step={0.1}
        value={cur}
        onChange={onSeek}
        disabled={!ready}
        aria-label="Seek recording"
        className="flex-1 h-1 accent-emerald-600 cursor-pointer disabled:cursor-default"
      />
      <span className="flex-shrink-0 text-[11px] tabular-nums font-mono text-gray-500 min-w-[78px] text-right">
        {fmtClock(cur) ?? "0:00"} / {ready ? fmtClock(dur) ?? "0:00" : "–:––"}
      </span>
    </div>
  );
}

// Cross-campaign attempt timeline. Answers "how many times was this lead
// dialed, and which attempt converted it?" — including attempts made in earlier
// (original / prior recall) campaigns, not just the one this drawer opened from.
function AttemptsTab({ data }: { data: TranscriptPayload }) {
  const attempts = data.attempts ?? [];
  if (attempts.length === 0) {
    return (
      <EmptyState
        icon={<History className="w-8 h-8 text-gray-300" />}
        title="No attempts yet"
        body="This lead has not been dialed in any campaign yet. Attempts will appear here as calls are placed."
      />
    );
  }

  const total = attempts.length;
  const convertedOn = data.convertedOnAttempt ?? null;

  return (
    <div className="px-6 py-5">
      <div
        className={`rounded-xl border px-4 py-3 mb-5 flex items-center gap-3 ${
          convertedOn
            ? "border-emerald-200 bg-emerald-50"
            : "border-gray-200 bg-gray-50"
        }`}
      >
        {convertedOn ? (
          <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
        ) : (
          <RotateCcw className="w-5 h-5 text-gray-400 flex-shrink-0" />
        )}
        <p className="text-sm">
          {convertedOn ? (
            <span className="font-semibold text-emerald-800">
              Converted on attempt {convertedOn} of {total}
            </span>
          ) : (
            <span className="font-medium text-gray-700">
              Not yet converted · {total} attempt{total === 1 ? "" : "s"}
            </span>
          )}
        </p>
      </div>

      <ol className="relative ml-2 space-y-4 border-l border-gray-200">
        {attempts.map((a) => {
          const tone = scoreToneClass(a.intentScore ?? null);
          const isConvertPoint = convertedOn === a.attempt;
          return (
            <li key={`${a.campaignId}-${a.attempt}`} className="ml-5">
              <span
                className={`absolute -left-[7px] mt-1.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                  isConvertPoint
                    ? "bg-emerald-500"
                    : a.converted
                      ? "bg-emerald-400"
                      : "bg-gray-300"
                }`}
              />
              <div
                className={`rounded-xl border px-4 py-3 ${
                  isConvertPoint
                    ? "border-emerald-300 bg-emerald-50/60 shadow-sm"
                    : "border-gray-200 bg-white"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-gray-900">
                    Attempt {a.attempt}
                  </span>
                  {a.isRecall && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">
                      <RotateCcw className="w-3 h-3" /> Recall
                    </span>
                  )}
                  {a.isCurrent && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 bg-blue-100 rounded-full px-2 py-0.5">
                      This campaign
                    </span>
                  )}
                  {isConvertPoint && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
                      <CheckCircle2 className="w-3 h-3" /> Converted
                    </span>
                  )}
                  {a.intentScore != null && (
                    <span
                      className={`ml-auto text-[11px] font-mono tabular-nums px-2 py-0.5 rounded-full ${tone.bg} ${tone.text}`}
                    >
                      {a.intentScore}/100
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-x-3 gap-y-1 text-xs text-gray-500 flex-wrap">
                  {a.campaignName && (
                    <span
                      className="truncate max-w-[240px]"
                      title={a.campaignName}
                    >
                      {a.campaignName}
                    </span>
                  )}
                  <StatusPill status={a.status} />
                  {a.callOutcome && <span>{formatOutcome(a.callOutcome)}</span>}
                  {a.startedAt && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(a.startedAt).toLocaleString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
                {/* This attempt's own recording — Bolna (stored URL) or
                    ElevenLabs (via the self-healing proxy). Each player owns its
                    own <audio>, so they play independently. */}
                {a.recordingUrl && (
                  <RecordingPlayer key={a.recordingUrl} url={a.recordingUrl} compact />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative py-3 font-medium transition-colors ${
        active ? "text-gray-900" : "text-gray-500 hover:text-gray-700"
      }`}
    >
      {children}
      {active && (
        <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-emerald-500 rounded-full" />
      )}
    </button>
  );
}

function TranscriptTab({
  turns,
  data,
}: {
  turns: ChatTurn[];
  data: TranscriptPayload;
}) {
  if (turns.length === 0) {
    return (
      <EmptyState
        icon={<AlertCircle className="w-8 h-8 text-rose-300" />}
        title={
          data.callOutcome
            ? `Call ended: ${formatOutcome(data.callOutcome)}`
            : "Transcript unavailable"
        }
        body={
          data.summary ??
          "The call ended before a conversation could be recorded. This can happen on no-answer, busy, or when the dealer hung up immediately."
        }
      />
    );
  }

  return (
    <div className="px-5 py-5 space-y-3">
      {turns.map((msg, i) => {
        const isUser = msg.role === "user";
        const clock = fmtClock(msg.tSec);
        return (
          <div
            key={i}
            className={`flex items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}
          >
            {!isUser && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center mb-1">
                <Bot className="w-3.5 h-3.5 text-emerald-700" />
              </div>
            )}
            <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} max-w-[78%]`}>
              <div
                className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                  isUser
                    ? "bg-white text-gray-900 border border-gray-200 rounded-br-md"
                    : "bg-emerald-50 text-gray-900 border border-emerald-100 rounded-bl-md"
                }`}
              >
                {msg.text}
              </div>
              {clock && (
                <span className="mt-1 text-[10px] tabular-nums font-mono text-gray-400 px-1">
                  {clock}
                </span>
              )}
            </div>
            {isUser && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center mb-1">
                <UserIcon className="w-3.5 h-3.5 text-gray-600" />
              </div>
            )}
          </div>
        );
      })}
      {data.bolnaCallId && (
        <p className="pt-4 text-center text-[10px] text-gray-400 font-mono">
          Call ID: {data.bolnaCallId}
        </p>
      )}
    </div>
  );
}

function OverviewTab({
  data,
  campaignId,
  leadId,
}: {
  data: TranscriptPayload;
  campaignId: string;
  leadId: string | null;
}) {
  const scoreTone = scoreToneClass(data.intentScore ?? null);
  return (
    <div className="px-6 py-5 space-y-6">
      <div className="grid grid-cols-[auto_1fr] gap-4 items-stretch">
        <div
          className={`rounded-2xl border-2 ${scoreTone.ring} ${scoreTone.bg} px-5 py-4 flex flex-col items-center justify-center min-w-[120px]`}
        >
          <div className={`text-4xl font-bold tabular-nums ${scoreTone.text}`}>
            {data.intentScore ?? "—"}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mt-1">
            Intent / 100
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 flex flex-col justify-center text-sm space-y-1.5">
          <MetaRow
            label="Outcome"
            value={data.callOutcome ? formatOutcome(data.callOutcome) : "—"}
          />
          <MetaRow label="Duration" value={fmtDuration(data.callDuration)} />
          <MetaRow
            label="Next action"
            value={data.nextAction ? formatOutcome(data.nextAction) : "—"}
          />
        </div>
      </div>

      {data.scoreBreakdown && data.scoreBreakdown.length > 0 ? (
        // Truthful breakdown — these contributions sum to the headline score.
        <section className="rounded-2xl border border-gray-200 bg-white p-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
            Score breakdown
          </h3>
          <div className="space-y-3">
            {data.scoreBreakdown.map((item, i) => (
              <BreakdownRow key={`${item.signal}-${i}`} item={item} />
            ))}
          </div>
          <div className="mt-3 flex items-baseline justify-between border-t border-gray-100 pt-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              Total intent
            </span>
            <span className="text-xs font-mono font-bold tabular-nums text-gray-800">
              {data.intentScore ?? 0}/100
            </span>
          </div>
          {data.intentReason && (
            <p className="mt-3 text-xs text-gray-600 italic border-l-2 border-emerald-200 pl-3">
              {data.intentReason}
            </p>
          )}
        </section>
      ) : data.analysis ? (
        // Legacy fallback for pre-refactor rows (no stored breakdown).
        <section className="rounded-2xl border border-gray-200 bg-white p-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
            Score breakdown
          </h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            {SUBSCORE_LABELS.map(({ key, label, hint }) => (
              <SubScoreBar key={key} label={label} hint={hint} value={data.analysis![key]} />
            ))}
          </div>
          {data.intentReason && (
            <p className="mt-4 text-xs text-gray-600 italic border-l-2 border-emerald-200 pl-3">
              {data.intentReason}
            </p>
          )}
        </section>
      ) : null}

      {/* Human-in-the-loop correction — only when we have a call to attribute it
          to. This is the entry point of the learning loop: corrections become
          the benchmark/golden set the eval + calibration levers learn from. */}
      {(data.callId || data.bolnaCallId) && leadId && (
        <CorrectScorePanel
          campaignId={campaignId}
          leadId={leadId}
          callId={data.callId ?? data.bolnaCallId!}
          intentScore={data.intentScore ?? null}
          signals={data.signals ?? null}
        />
      )}

      {data.summary && (
        <section>
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
            Call summary
          </h3>
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 px-4 py-3 text-sm text-gray-800 leading-relaxed">
            {data.summary}
          </div>
        </section>
      )}
    </div>
  );
}

// "Correct this score" — the teach-it's-wrong affordance. Quick mode captures
// the true status label (+ optional note); deep mode lets a reviewer fix each
// over-read signal level (e.g. curiosity strong → none on a thin call). Submits
// to /intent-feedback, where it becomes a golden/benchmark row.
function CorrectScorePanel({
  campaignId,
  leadId,
  callId,
  intentScore,
  signals,
}: {
  campaignId: string;
  leadId: string;
  callId: string;
  intentScore: number | null;
  signals: ClientSignals | null;
}) {
  const qc = useQueryClient();
  const [openPanel, setOpenPanel] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [scoreText, setScoreText] = useState<string>("");
  const [note, setNote] = useState("");
  const [deep, setDeep] = useState(false);
  // Per-signal level overrides, seeded from the call's extracted signals.
  const [levels, setLevels] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const { key } of CORRECTABLE_SIGNALS) {
      seed[key as string] = (signals?.[key] as LeveledSignal | undefined)?.level ?? "unknown";
    }
    return seed;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feedbackKey = ["intent-feedback", campaignId, leadId, callId];
  const { data: existing } = useQuery<{
    feedback: Array<{
      id: string;
      correctedStatus: string;
      correctedScore: number | null;
      createdAt: string;
    }>;
  }>({
    queryKey: feedbackKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/leads/${leadId}/intent-feedback?callId=${encodeURIComponent(callId)}`,
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Failed");
      return json.data;
    },
  });
  const lastCorrection = existing?.feedback?.[0] ?? null;

  async function submit() {
    if (!status) {
      setError("Pick the correct status first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    // Deep mode: carry the original signals through, overriding edited levels.
    let correctedSignals: ClientSignals | null = null;
    if (deep) {
      const base: ClientSignals = signals ? { ...signals } : {};
      for (const { key } of CORRECTABLE_SIGNALS) {
        const prev = (base[key] as LeveledSignal | undefined) ?? { level: "unknown", evidence: "" };
        base[key] = { ...prev, level: levels[key as string] };
      }
      correctedSignals = base;
    }
    const parsedScore = scoreText.trim() === "" ? null : Number(scoreText);
    try {
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/leads/${leadId}/intent-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callId,
            correctedStatus: status,
            correctedScore:
              parsedScore != null && Number.isFinite(parsedScore) ? parsedScore : null,
            correctedSignals,
            note: note.trim() || null,
          }),
        },
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Save failed");
      await qc.invalidateQueries({ queryKey: feedbackKey });
      setOpenPanel(false);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-amber-700 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          Score looks wrong?
        </h3>
        {!openPanel && (
          <button
            type="button"
            onClick={() => setOpenPanel(true)}
            className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2"
          >
            Correct this score
          </button>
        )}
      </div>

      {lastCorrection && (
        <p className="mt-2 text-[11px] text-amber-700 flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          Last corrected to <b className="capitalize">{lastCorrection.correctedStatus}</b>
          {lastCorrection.correctedScore != null && <> ({lastCorrection.correctedScore}/100)</>}
        </p>
      )}

      {openPanel && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] text-gray-600">
            AI scored this <b>{intentScore ?? "—"}/100</b>. Tell the system the correct
            outcome so it can learn.
          </p>

          {/* Quick mode — the true status label */}
          <div>
            <label className="block text-[11px] font-semibold text-gray-600 mb-1">
              Correct status
            </label>
            <div className="flex flex-wrap gap-1.5">
              {LEAD_STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold capitalize border ${
                    status === s
                      ? "bg-amber-500 text-white border-amber-500"
                      : "bg-white text-gray-700 border-gray-200 hover:border-amber-300"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[11px] font-semibold text-gray-600">
              Correct score (optional)
            </label>
            <input
              type="number"
              min={0}
              max={100}
              value={scoreText}
              onChange={(e) => setScoreText(e.target.value)}
              placeholder="0–100"
              className="w-20 h-8 rounded-lg border border-gray-200 px-2 text-xs"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-gray-600 mb-1">
              Note (optional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. only two garbled lines, dealer showed no real interest"
              className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
            />
          </div>

          {/* Deep mode — per-signal correction */}
          <button
            type="button"
            onClick={() => setDeep((d) => !d)}
            className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2"
          >
            {deep ? "Hide signal details" : "Refine signals (advanced)"}
          </button>
          {deep && (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-amber-100 bg-white p-3">
              {CORRECTABLE_SIGNALS.map(({ key, label, levels: opts }) => (
                <label key={key as string} className="text-[11px] text-gray-600">
                  <span className="block font-semibold mb-0.5">{label}</span>
                  <select
                    value={levels[key as string] ?? "unknown"}
                    onChange={(e) =>
                      setLevels((prev) => ({ ...prev, [key as string]: e.target.value }))
                    }
                    className="w-full h-8 rounded-lg border border-gray-200 px-1 text-xs"
                  >
                    {opts.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {lvl.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}

          {error && <p className="text-[11px] text-red-600">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
              Save correction
            </button>
            <button
              type="button"
              onClick={() => setOpenPanel(false)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function DetailsTab({ data }: { data: TranscriptPayload }) {
  return (
    <div className="px-6 py-5 space-y-4 text-sm">
      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-2">
        <DetailRow label="Lead" value={data.leadName ?? "—"} />
        <DetailRow label="Phone" value={data.phone ?? "—"} />
        <DetailRow
          label="Location"
          value={[data.city, data.state].filter(Boolean).join(", ") || "—"}
        />
        <DetailRow label="Provider" value={data.provider?.toUpperCase() ?? "—"} />
        <DetailRow label="Campaign status" value={data.campaignLeadStatus} />
        <DetailRow label="Call status" value={data.callStatus ?? "—"} />
        <DetailRow
          label="Started"
          value={data.startedAt ? new Date(data.startedAt).toLocaleString() : "—"}
        />
        <DetailRow
          label="Ended"
          value={data.completedAt ? new Date(data.completedAt).toLocaleString() : "—"}
        />
        <DetailRow
          label="Recording"
          value={
            data.recordingUrl ? (
              <a
                href={data.recordingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-800 font-medium"
              >
                <PlayCircle className="w-3.5 h-3.5" /> Open
              </a>
            ) : (
              "—"
            )
          }
        />
        <DetailRow
          label="Call ID"
          value={
            data.bolnaCallId ? (
              <span className="font-mono text-[11px] text-gray-500">{data.bolnaCallId}</span>
            ) : (
              "—"
            )
          }
        />
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-wider text-gray-400 font-medium">
        {label}
      </span>
      <span className="text-sm text-gray-800 font-medium">{value}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 items-baseline">
      <span className="text-[11px] uppercase tracking-wider text-gray-400 font-medium">
        {label}
      </span>
      <span className="text-sm text-gray-800">{value}</span>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="px-8 py-20 flex flex-col items-center justify-center text-center">
      <div className="mb-4">{icon}</div>
      <h4 className="text-sm font-semibold text-gray-900">{title}</h4>
      <p className="mt-1.5 text-xs text-gray-500 max-w-sm leading-relaxed">{body}</p>
    </div>
  );
}

function formatOutcome(o: string): string {
  return o
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}
