"use client";

/**
 * Field Investigation track panel — BRD Addendum V0.3.1 §10 (Model C).
 *
 * The FI Coordinator picks an agent from the directory and sends a single-use
 * link; the agent submits the field form on their phone; the Coordinator
 * reviews (FiReviewPanel) and decides. This panel orchestrates the lead-side
 * flow: assign / send link, resend, status + SLA, review, history.
 */
import { useCallback, useEffect, useState } from "react";

import FiReviewPanel, {
  type FiAgentLite,
  type FiAutoFlagLite,
  type FiPhotoLite,
  type FiTrackLite,
} from "./FiReviewPanel";

interface Track extends FiTrackLite {
  id: string;
  assigned_to: string | null;
  assigned_agent_id: string | null;
  sla_due_at: string | null;
  sla_breached: boolean;
  link_channel: string | null;
  link_sent_at: string | null;
}
interface HistoryRow {
  id: string;
  attempt_no: number;
  status: string;
  decision: string | null;
  decision_reason: string | null;
  assigned_to: string | null;
  decided_at: string | null;
}
interface Resp {
  ok: boolean;
  track: Track | null;
  photos: FiPhotoLite[];
  agent: FiAgentLite | null;
  auto_flags: FiAutoFlagLite[];
  history: HistoryRow[];
  agents: FiAgentLite[];
  can_act?: boolean;
  can_reopen?: boolean;
  enabled?: boolean;
  error?: string;
}

type Channel = "email" | "sms" | "whatsapp";

const CHANNELS: { key: Channel; label: string }[] = [
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
];

/** Default link channel: agent's preference if its contact exists, else first usable. */
function pickDefaultChannel(a?: { email?: string | null; phone?: string | null; preferred_channel?: string | null } | null): Channel {
  const pref = (a?.preferred_channel as Channel) || "email";
  const hasEmail = !!a?.email?.trim();
  const hasPhone = !!a?.phone?.trim();
  if (pref === "email" && hasEmail) return "email";
  if ((pref === "sms" || pref === "whatsapp") && hasPhone) return pref;
  if (hasEmail) return "email";
  if (hasPhone) return "sms";
  return "email";
}

/** Status presentation — pill colours + the left accent bar tint. */
const STATUS_META: Record<string, { label: string; text: string; bg: string; dot: string; accent: string }> = {
  passed: { label: "Passed", text: "text-emerald-700", bg: "bg-emerald-50 ring-emerald-200", dot: "bg-emerald-500", accent: "#059669" },
  failed: { label: "Failed", text: "text-rose-700", bg: "bg-rose-50 ring-rose-200", dot: "bg-rose-500", accent: "#e11d48" },
  assigned: { label: "Assigned", text: "text-sky-700", bg: "bg-sky-50 ring-sky-200", dot: "bg-sky-500", accent: "#0ea5e9" },
  in_progress: { label: "In progress", text: "text-amber-700", bg: "bg-amber-50 ring-amber-200", dot: "bg-amber-500", accent: "#d97706" },
  submitted: { label: "Ready to review", text: "text-indigo-700", bg: "bg-indigo-50 ring-indigo-200", dot: "bg-indigo-500", accent: "#4f46e5" },
  pending: { label: "Not started", text: "text-slate-500", bg: "bg-slate-100 ring-slate-200", dot: "bg-slate-400", accent: "#94a3b8" },
  re_inspection_requested: { label: "Re-inspection", text: "text-orange-700", bg: "bg-orange-50 ring-orange-200", dot: "bg-orange-500", accent: "#ea580c" },
  not_applicable: { label: "Not applicable", text: "text-slate-500", bg: "bg-slate-100 ring-slate-200", dot: "bg-slate-400", accent: "#94a3b8" },
};
function statusMeta(s: string) {
  return STATUS_META[s] ?? STATUS_META.pending;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  if (channel === "email") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
      </svg>
    );
  }
  // sms / whatsapp share a chat bubble glyph
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8 8.38 8.38 0 0 1 8.5-8.5A8.38 8.38 0 0 1 21 11.5z" />
    </svg>
  );
}

function FiGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

/** Three-way segmented picker; disables a channel when the agent lacks that contact. */
function ChannelPicker({
  value,
  onChange,
  hasEmail,
  hasPhone,
}: {
  value: Channel;
  onChange: (c: Channel) => void;
  hasEmail: boolean;
  hasPhone: boolean;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 shadow-inner">
      {CHANNELS.map((c) => {
        const disabled = c.key === "email" ? !hasEmail : !hasPhone;
        const active = value === c.key;
        return (
          <button
            key={c.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(c.key)}
            title={disabled ? (c.key === "email" ? "No email on file for this agent" : "No phone on file for this agent") : undefined}
            className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
              active ? "bg-white text-[color:var(--color-brand-navy)] shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-700"
            } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
          >
            <ChannelIcon channel={c.key} className="h-3 w-3" />
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const m = statusMeta(status);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${m.bg} ${m.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

export default function FiTrackPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [channel, setChannel] = useState<Channel>("email");
  const [showReview, setShowReview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/fi/${leadId}`);
      setData((await res.json()) as Resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/fi/${leadId}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const track = data?.track ?? null;
  const status = track?.status ?? "pending";
  const canAct = data?.can_act ?? false;
  const enabled = data?.enabled ?? true;
  const agents = data?.agents ?? [];
  const selectedAgent = agents.find((a) => a.id === agentId) ?? null;
  const meta = statusMeta(status);

  // Default the channel for the resend case from the already-assigned agent.
  const assignedAgentId = data?.agent?.id;
  useEffect(() => {
    if (data?.agent) setChannel(pickDefaultChannel(data.agent));
  }, [assignedAgentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // For resend, contact availability comes from the assigned agent; for assign, the picked one.
  const channelAgent = status === "assigned" || status === "in_progress" ? data?.agent : selectedAgent;
  const hasEmail = !!channelAgent?.email?.trim();
  const hasPhone = !!channelAgent?.phone?.trim();

  // SLA — remaining hours + a 48h-window progress fraction for the bar.
  const sla = (() => {
    if (!track?.sla_due_at) return null;
    const due = new Date(track.sla_due_at);
    const msLeft = due.getTime() - Date.now();
    const hrs = Math.max(0, Math.round(msLeft / 3600000));
    const pct = Math.max(0, Math.min(100, (msLeft / (48 * 3600000)) * 100));
    const breached = track.sla_breached || msLeft <= 0;
    return { due, hrs, pct, breached };
  })();
  const showSla = sla && status !== "passed" && status !== "failed";

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(2,49,78,0.04),0_12px_28px_-16px_rgba(2,49,78,0.18)]">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="relative flex items-start gap-3 bg-gradient-to-br from-white to-slate-50 px-4 pb-3.5 pt-4">
        <span className="absolute inset-y-0 left-0 w-1" style={{ background: meta.accent }} />
        <div
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white shadow-sm"
          style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-sky), var(--color-brand-royal))" }}
        >
          <FiGlyph className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-slate-900">Field Investigation</h3>
            {track && <StatusPill status={status} />}
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">On-ground residence &amp; identity check · §10</p>

          {/* Agent chip */}
          {track?.assigned_to && (
            <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-slate-200/80 bg-white px-2.5 py-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[color:var(--color-brand-navy)] text-[10px] font-bold text-white">
                {initials(track.assigned_to)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-slate-800">{track.assigned_to}</p>
                <p className="text-[10px] text-slate-400">Field agent</p>
              </div>
              {track.link_channel && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-sky-soft)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[color:var(--color-brand-sky)]">
                  <ChannelIcon channel={track.link_channel} className="h-2.5 w-2.5" />
                  {track.link_channel}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── SLA strip ────────────────────────────────────────────────────── */}
      {showSla && sla && (
        <div className="px-4 pb-3">
          <div className="flex items-center justify-between text-[10px]">
            <span className={`font-semibold uppercase tracking-wide ${sla.breached ? "text-rose-600" : "text-slate-400"}`}>
              {sla.breached ? "48-hour SLA breached" : "48-hour SLA"}
            </span>
            <span className={`font-semibold tabular-nums ${sla.breached ? "text-rose-600" : sla.hrs <= 8 ? "text-amber-600" : "text-slate-500"}`}>
              {sla.breached ? "overdue" : `~${sla.hrs}h left`} · due {sla.due.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${sla.breached ? 100 : sla.pct}%`,
                background: sla.breached ? "#e11d48" : sla.hrs <= 8 ? "#d97706" : "linear-gradient(90deg, var(--color-brand-sky), var(--color-brand-royal))",
              }}
            />
          </div>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="space-y-3 px-4 pb-4">
        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 ring-1 ring-rose-100">{error}</p>
        )}

        {canAct && !enabled && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500 ring-1 ring-slate-100">
            Not opted in for this lead. Enable Field Investigation in{" "}
            <a href="/nbfc/settings" className="font-semibold text-[color:var(--color-brand-sky)] underline">
              Settings → Service Opt-In
            </a>
            .
          </p>
        )}

        {/* Assign (no current attempt yet, or still pending) */}
        {canAct && enabled && (!track || status === "pending") && (
          <div className="space-y-2.5 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-3">
            <p className="text-[11px] font-semibold text-slate-600">Assign a field agent</p>
            <select
              value={agentId}
              onChange={(e) => {
                const id = e.target.value;
                setAgentId(id);
                const a = agents.find((x) => x.id === id);
                if (a) setChannel(pickDefaultChannel(a));
              }}
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700 shadow-sm focus:border-[color:var(--color-brand-sky)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-sky-soft)]"
            >
              <option value="">Select an FI agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.city ? ` · ${a.city}` : ""}
                </option>
              ))}
            </select>
            {agentId && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-slate-500">Send link via</span>
                <ChannelPicker value={channel} onChange={setChannel} hasEmail={hasEmail} hasPhone={hasPhone} />
              </div>
            )}
            <button
              onClick={() => agentId && act({ action: "assign", agent_id: agentId, channel })}
              disabled={busy || !agentId}
              className="w-full rounded-lg px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40"
              style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-sky), var(--color-brand-navy))" }}
            >
              {busy ? "Sending…" : "Assign & send link"}
            </button>
            {agents.length === 0 && (
              <p className="text-[11px] text-slate-500">
                No FI agents yet.{" "}
                <a href="/nbfc/settings" className="font-semibold text-[color:var(--color-brand-sky)] underline">
                  Manage FI Agents →
                </a>
              </p>
            )}
          </div>
        )}

        {/* Link dispatched, awaiting agent submission */}
        {canAct && enabled && (status === "assigned" || status === "in_progress") && (
          <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3">
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              Waiting for the agent to submit the field form.
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-slate-500">Resend via</span>
              <ChannelPicker value={channel} onChange={setChannel} hasEmail={hasEmail} hasPhone={hasPhone} />
              <button
                onClick={() => act({ action: "resend_link", channel })}
                disabled={busy}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-brand-sky)] shadow-sm transition hover:bg-slate-50 disabled:opacity-40"
              >
                {busy ? "Resending…" : "Resend link"}
              </button>
            </div>
          </div>
        )}

        {/* Submitted → review */}
        {track && (status === "submitted" || status === "passed" || status === "failed") && (
          <div className="space-y-2">
            <button
              onClick={() => setShowReview((s) => !s)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold transition ${
                status === "submitted"
                  ? "text-white shadow-sm hover:brightness-110"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
              style={status === "submitted" ? { backgroundImage: "linear-gradient(135deg, var(--color-brand-sky), var(--color-brand-navy))" } : undefined}
            >
              <span>{showReview ? "Hide review" : status === "submitted" ? "Review visit" : "View review"}</span>
              <span className={`transition-transform ${showReview ? "rotate-90" : ""}`}>›</span>
            </button>
            {showReview && (
              <FiReviewPanel
                leadId={leadId}
                track={track}
                photos={data?.photos ?? []}
                agent={data?.agent ?? null}
                flags={data?.auto_flags ?? []}
                agents={agents}
                canAct={canAct}
                canReopen={data?.can_reopen ?? false}
                onChanged={() => {
                  void load();
                }}
              />
            )}
          </div>
        )}

        {/* History */}
        {data?.history && data.history.length > 0 && (
          <div className="border-t border-slate-100 pt-2">
            <button onClick={() => setShowHistory((s) => !s)} className="text-[11px] font-medium text-slate-400 underline-offset-2 hover:underline">
              {showHistory ? "Hide history" : `View prior attempts (${data.history.length})`}
            </button>
            {showHistory && (
              <ul className="mt-1.5 space-y-1">
                {data.history.map((h) => (
                  <li key={h.id} className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-slate-100 text-[9px] font-bold text-slate-400">{h.attempt_no}</span>
                    <span>
                      {h.status.replace(/_/g, " ")}
                      {h.assigned_to ? ` · ${h.assigned_to}` : ""}
                      {h.decision_reason ? ` — “${h.decision_reason}”` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
