// Slide-in right drawer that shows the full transcript of an AI call placed
// during a campaign, plus the analyzer's 6-dimension intent breakdown and a
// summary. Driven by /api/ai-dialer/campaigns/[id]/leads/[leadId]/transcript.
//
// Layout is tabbed (Overview / Transcription / Details) so the transcript
// always has full vertical space — that's the primary thing reviewers come
// here to read. Chat bubbles render any language (Hindi included) without
// per-language hacks because we just render the raw turn text.

"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  X,
  Phone,
  MapPin,
  Clock,
  PlayCircle,
  Sparkles,
  AlertCircle,
  Loader2,
  Bot,
  User as UserIcon,
} from "lucide-react";

type SubScores = {
  next_step_commitment: number;
  urgency_signals: number;
  product_curiosity: number;
  need_acknowledgment: number;
  objection_quality: number;
  engagement_depth: number;
};

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
  if (score >= 70)
    return { ring: "border-emerald-300", text: "text-emerald-700", bar: "bg-emerald-500", bg: "bg-emerald-50" };
  if (score >= 40)
    return { ring: "border-amber-300", text: "text-amber-700", bar: "bg-amber-500", bg: "bg-amber-50" };
  return { ring: "border-rose-300", text: "text-rose-700", bar: "bg-rose-500", bg: "bg-rose-50" };
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

type TabKey = "overview" | "transcript" | "details";

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

          {data?.recordingUrl && (
            <a
              href={data.recordingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800 py-3"
            >
              <PlayCircle className="w-4 h-4" />
              Recording
            </a>
          )}
        </div>

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
          ) : !data ? null : status === "pending" ? (
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
            <OverviewTab data={data} />
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

function OverviewTab({ data }: { data: TranscriptPayload }) {
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

      {data.analysis && (
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
