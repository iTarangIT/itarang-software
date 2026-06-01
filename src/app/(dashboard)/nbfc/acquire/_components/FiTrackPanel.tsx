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
  const pref = ((a?.preferred_channel as Channel) || "email");
  const hasEmail = !!a?.email?.trim();
  const hasPhone = !!a?.phone?.trim();
  if (pref === "email" && hasEmail) return "email";
  if ((pref === "sms" || pref === "whatsapp") && hasPhone) return pref;
  if (hasEmail) return "email";
  if (hasPhone) return "sms";
  return "email";
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
    <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
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
            className={`px-2.5 py-1 text-[11px] font-semibold border-r border-slate-200 last:border-r-0 ${
              active ? "bg-[color:var(--color-brand-navy)] text-white" : "bg-white text-slate-600"
            } ${disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-slate-50"}`}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

const BADGE: Record<string, string> = {
  passed: "bg-emerald-100 text-emerald-700",
  assigned: "bg-sky-100 text-sky-700",
  in_progress: "bg-amber-100 text-amber-700",
  submitted: "bg-indigo-100 text-indigo-700",
  pending: "bg-slate-100 text-slate-500",
  failed: "bg-red-100 text-red-700",
  re_inspection_requested: "bg-orange-100 text-orange-700",
  not_applicable: "bg-slate-100 text-slate-500",
};

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

  // Default the channel for the resend case from the already-assigned agent.
  const assignedAgentId = data?.agent?.id;
  useEffect(() => {
    if (data?.agent) setChannel(pickDefaultChannel(data.agent));
  }, [assignedAgentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // For resend, contact availability comes from the assigned agent; for assign, the picked one.
  const channelAgent = status === "assigned" || status === "in_progress" ? data?.agent : selectedAgent;
  const hasEmail = !!channelAgent?.email?.trim();
  const hasPhone = !!channelAgent?.phone?.trim();

  const slaLabel = (() => {
    if (!track?.sla_due_at) return null;
    if (track.sla_breached) return "⚠ 48-hour SLA breached.";
    const due = new Date(track.sla_due_at);
    const hrs = Math.max(0, Math.round((due.getTime() - Date.now()) / 3600000));
    return `SLA due ${due.toLocaleString("en-IN")} (~${hrs}h left)`;
  })();

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">Field Investigation</span>
        {track && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${BADGE[status] ?? "bg-slate-100 text-slate-500"}`}>
            {status.replace(/_/g, " ")}
          </span>
        )}
      </div>

      {track?.assigned_to && (
        <p className="text-[11px] text-slate-500">
          Agent: {track.assigned_to}
          {track.link_channel ? ` · link sent via ${track.link_channel}` : ""}
        </p>
      )}
      {slaLabel && status !== "passed" && status !== "failed" && (
        <p className={`text-[11px] ${track?.sla_breached ? "text-red-600 font-semibold" : "text-slate-400"}`}>{slaLabel}</p>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      {canAct && !enabled && (
        <p className="text-[11px] text-slate-500">
          Not opted in for this lead. Enable Field Investigation in{" "}
          <a href="/nbfc/settings" className="underline text-[color:var(--color-brand-sky)]">
            Settings → Service Opt-In
          </a>
          .
        </p>
      )}

      {/* Assign (no current attempt yet, or still pending) */}
      {canAct && enabled && (!track || status === "pending") && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <select
              value={agentId}
              onChange={(e) => {
                const id = e.target.value;
                setAgentId(id);
                const a = agents.find((x) => x.id === id);
                if (a) setChannel(pickDefaultChannel(a));
              }}
              className="flex-1 text-xs border border-slate-200 rounded-md px-2 py-1.5"
            >
              <option value="">Select an FI agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.city ? ` · ${a.city}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => agentId && act({ action: "assign", agent_id: agentId, channel })}
              disabled={busy || !agentId}
              className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
            >
              Assign &amp; send link
            </button>
          </div>
          {agentId && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">Send link via</span>
              <ChannelPicker value={channel} onChange={setChannel} hasEmail={hasEmail} hasPhone={hasPhone} />
            </div>
          )}
          {agents.length === 0 && (
            <p className="text-[11px] text-slate-500">
              No FI agents yet.{" "}
              <a href="/nbfc/settings" className="underline text-[color:var(--color-brand-sky)]">
                Manage FI Agents →
              </a>
            </p>
          )}
        </div>
      )}

      {/* Link dispatched, awaiting agent submission */}
      {canAct && enabled && (status === "assigned" || status === "in_progress") && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500">Waiting for the agent to submit the field form.</p>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500">Resend via</span>
            <ChannelPicker value={channel} onChange={setChannel} hasEmail={hasEmail} hasPhone={hasPhone} />
            <button
              onClick={() => act({ action: "resend_link", channel })}
              disabled={busy}
              className="text-[11px] font-semibold text-[color:var(--color-brand-sky)] underline disabled:opacity-50"
            >
              Resend link
            </button>
          </div>
        </div>
      )}

      {/* Submitted → review */}
      {track && (status === "submitted" || status === "passed" || status === "failed") && (
        <div className="space-y-2">
          <button onClick={() => setShowReview((s) => !s)} className="text-[11px] font-semibold text-[color:var(--color-brand-sky)] underline">
            {showReview ? "Hide review" : status === "submitted" ? "Review visit →" : "View review"}
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
        <div className="pt-1">
          <button onClick={() => setShowHistory((s) => !s)} className="text-[11px] text-slate-400 underline">
            {showHistory ? "Hide history" : `View history (${data.history.length})`}
          </button>
          {showHistory && (
            <ul className="mt-1 space-y-1">
              {data.history.map((h) => (
                <li key={h.id} className="text-[11px] text-slate-500">
                  Attempt {h.attempt_no}: {h.status.replace(/_/g, " ")}
                  {h.assigned_to ? ` · ${h.assigned_to}` : ""}
                  {h.decision_reason ? ` — “${h.decision_reason}”` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
