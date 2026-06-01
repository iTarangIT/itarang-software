"use client";

/**
 * FI Coordinator Review Screen — BRD Addendum V0.3.1 §10.8.
 *
 * Renders the submitted field visit for review: Location Evidence (stated vs
 * captured + distance + map), Agent Identity (reference vs selfie), Evidence
 * Photos, the agent's Field Observation, the auto-flags (§10.8.1, surfaced not
 * auto-failing), and — for the Coordinator only — the Decision panel
 * (Pass / Fail / Request re-inspection). Read-only for everyone else (§10.8.3).
 * NBFC Admin can reopen a decided attempt.
 */
import { useState } from "react";

export interface FiAgentLite {
  id: string;
  name: string;
  city: string | null;
  reference_photo_url: string | null;
  // Contact + preference, used by the link-channel picker in FiTrackPanel.
  email?: string | null;
  phone?: string | null;
  preferred_channel?: string | null;
}
export interface FiPhotoLite {
  id: string;
  photo_type: string;
  image_url: string;
  watermark_applied: boolean;
}
export interface FiAutoFlagLite {
  key: string;
  severity: "red" | "warn";
  label: string;
}
export interface FiTrackLite {
  status: string;
  attempt_no: number;
  gps_lat: string | null;
  gps_lng: string | null;
  gps_accuracy_m: string | null;
  stated_lat: string | null;
  stated_lng: string | null;
  distance_from_address_m: string | null;
  address_match: string | null;
  address_match_notes: string | null;
  customer_present: boolean | null;
  customer_present_notes: string | null;
  agent_notes: string | null;
  decision: string | null;
  decision_reason: string | null;
  submitted_at: string | null;
}

const PHOTO_LABELS: Record<string, string> = {
  exterior: "Exterior",
  customer_at_residence: "Customer at residence",
  corroborator: "Corroborator",
  agent_selfie: "Agent selfie",
  extra: "Extra",
};

type IconName = "pin" | "user" | "image" | "clipboard" | "flag";

function SectionIcon({ name, className }: { name: IconName; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "pin":
      return (<svg {...common}><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z" /><circle cx="12" cy="10" r="3" /></svg>);
    case "user":
      return (<svg {...common}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>);
    case "image":
      return (<svg {...common}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></svg>);
    case "clipboard":
      return (<svg {...common}><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></svg>);
    case "flag":
      return (<svg {...common}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>);
  }
}

export default function FiReviewPanel({
  leadId,
  track,
  photos,
  agent,
  flags,
  agents,
  canAct,
  canReopen,
  onChanged,
}: {
  leadId: string;
  track: FiTrackLite;
  photos: FiPhotoLite[];
  agent: FiAgentLite | null;
  flags: FiAutoFlagLite[];
  agents: FiAgentLite[];
  canAct: boolean;
  canReopen: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"none" | "fail" | "reinspect" | "reopen">("none");
  const [reason, setReason] = useState("");
  const [reAgent, setReAgent] = useState("");

  const decided = track.status === "passed" || track.status === "failed";
  const selfie = photos.find((p) => p.photo_type === "agent_selfie");
  const evidencePhotos = photos.filter((p) => p.photo_type !== "agent_selfie");
  const captured = track.gps_lat && track.gps_lng ? `${track.gps_lat}, ${track.gps_lng}` : "—";
  const mapHref = track.gps_lat && track.gps_lng ? `https://www.google.com/maps?q=${track.gps_lat},${track.gps_lng}` : null;
  const distanceFar = track.distance_from_address_m != null && Number(track.distance_from_address_m) > 50;

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
      setMode("none");
      setReason("");
      setReAgent("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-slate-200/80 bg-slate-50/60 p-3">
      {/* Location evidence */}
      <Section icon="pin" title="Location evidence">
        <div className="grid grid-cols-2 gap-2">
          <Stat k="Stated (geocoded)" v={track.stated_lat && track.stated_lng ? `${track.stated_lat}, ${track.stated_lng}` : "not geocoded"} mono />
          <Stat k="Captured at visit" v={captured} mono />
          <Stat
            k="Distance from address"
            v={track.distance_from_address_m != null ? `${track.distance_from_address_m} m` : "not computable"}
            danger={distanceFar}
          />
          <Stat k="GPS accuracy" v={track.gps_accuracy_m != null ? `±${track.gps_accuracy_m} m` : "—"} />
        </div>
        {mapHref && (
          <a
            href={mapHref}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-brand-sky)] shadow-sm transition hover:bg-slate-50"
          >
            <SectionIcon name="pin" className="h-3 w-3" />
            Open captured point in Maps →
          </a>
        )}
      </Section>

      {/* Agent identity */}
      <Section icon="user" title="Agent identity">
        <div className="flex gap-3">
          <Thumb label="Reference" url={agent?.reference_photo_url ?? null} />
          <Thumb label="Field selfie" url={selfie?.image_url ?? null} />
        </div>
        <p className="mt-1.5 text-[10px] text-slate-400">Visual comparison only — no automated face match (§10.7).</p>
      </Section>

      {/* Evidence photos */}
      <Section icon="image" title="Evidence photos">
        <div className="grid grid-cols-3 gap-2">
          {evidencePhotos.map((p) => (
            <a key={p.id} href={p.image_url} target="_blank" rel="noreferrer" className="group block">
              <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.image_url} alt={p.photo_type} className="h-20 w-full object-cover transition duration-300 group-hover:scale-105" />
                {!p.watermark_applied && (
                  <span className="absolute right-1 top-1 rounded bg-amber-500/90 px-1 text-[8px] font-bold uppercase text-white">no wm</span>
                )}
              </div>
              <p className="mt-1 truncate text-[9px] font-medium text-slate-500">{PHOTO_LABELS[p.photo_type] ?? p.photo_type}</p>
            </a>
          ))}
          {evidencePhotos.length === 0 && <p className="text-[11px] text-slate-400">No photos.</p>}
        </div>
      </Section>

      {/* Field observation */}
      <Section icon="clipboard" title="Agent's field observation">
        <div className="grid grid-cols-2 gap-2">
          <Stat k="Address match" v={track.address_match ?? "—"} danger={track.address_match === "no" || track.address_match === "partial"} />
          <Stat k="Customer present" v={track.customer_present == null ? "—" : track.customer_present ? "Yes" : "No"} danger={track.customer_present === false} />
        </div>
        {track.address_match_notes && <p className="mt-1.5 text-[11px] italic text-slate-500">“{track.address_match_notes}”</p>}
        {track.customer_present_notes && <p className="mt-1 text-[11px] italic text-slate-500">“{track.customer_present_notes}”</p>}
        {track.agent_notes && (
          <p className="mt-1.5 rounded-lg bg-white px-2.5 py-1.5 text-[11px] text-slate-600 ring-1 ring-slate-100">
            <span className="font-semibold text-slate-400">Notes · </span>
            {track.agent_notes}
          </p>
        )}
      </Section>

      {/* Auto-flags */}
      {flags.length > 0 && (
        <Section icon="flag" title="Auto-flags · review only, never auto-fail">
          <ul className="space-y-1.5">
            {flags.map((f) => (
              <li
                key={f.key}
                className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ring-1 ${
                  f.severity === "red" ? "bg-rose-50 text-rose-700 ring-rose-100" : "bg-amber-50 text-amber-700 ring-amber-100"
                }`}
              >
                <span className="mt-px">{f.severity === "red" ? "⛔" : "⚠"}</span>
                <span>{f.label}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 ring-1 ring-rose-100">{error}</p>}

      {/* Decision panel */}
      {decided ? (
        <div className={`rounded-xl p-3 ring-1 ${track.status === "passed" ? "bg-emerald-50 ring-emerald-100" : "bg-rose-50 ring-rose-100"}`}>
          <div className="flex items-center gap-2">
            <span className={`grid h-7 w-7 place-items-center rounded-full text-white ${track.status === "passed" ? "bg-emerald-500" : "bg-rose-500"}`}>
              {track.status === "passed" ? "✓" : "✕"}
            </span>
            <div>
              <p className="text-xs font-bold text-slate-800">Visit {track.status === "passed" ? "passed" : "failed"}</p>
              {track.decision_reason && <p className="text-[11px] text-slate-500">{track.decision_reason}</p>}
            </div>
          </div>
          {(canReopen || canAct) && mode !== "reopen" && (
            <div className="mt-2.5 flex flex-wrap gap-3">
              {canReopen && (
                <button onClick={() => setMode("reopen")} className="text-[11px] font-semibold text-[color:var(--color-brand-sky)] underline-offset-2 hover:underline">
                  Reopen decision
                </button>
              )}
              {canAct && (
                <button onClick={() => setMode("reinspect")} className="text-[11px] font-semibold text-amber-700 underline-offset-2 hover:underline">
                  Request re-inspection
                </button>
              )}
            </div>
          )}
          {mode === "reopen" && (
            <div className="mt-2">
              <ReasonBox value={reason} onChange={setReason} placeholder="Reason for reopening…" busy={busy} onSubmit={() => reason.trim() && act({ action: "reopen", reason })} submitLabel="Confirm reopen" onCancel={() => setMode("none")} />
            </div>
          )}
          {mode === "reinspect" && (
            <div className="mt-2 space-y-2">
              <ReAssign agents={agents} value={reAgent} onChange={setReAgent} />
              <ReasonBox value={reason} onChange={setReason} placeholder="Reason for re-inspection (required)…" busy={busy} onSubmit={() => reAgent && reason.trim() && act({ action: "reinspect", agent_id: reAgent, reason })} submitLabel="Send re-inspection" onCancel={() => setMode("none")} />
            </div>
          )}
        </div>
      ) : canAct ? (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Coordinator decision</p>
          {mode === "none" && (
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => act({ action: "decide", decision: "pass" })}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40"
              >
                ✓ Pass
              </button>
              <button
                onClick={() => setMode("fail")}
                disabled={busy}
                className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:opacity-40"
              >
                ✕ Fail
              </button>
              <button
                onClick={() => setMode("reinspect")}
                disabled={busy}
                className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-2 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-40"
              >
                ↻ Re-inspect
              </button>
            </div>
          )}
          {mode === "fail" && (
            <ReasonBox value={reason} onChange={setReason} placeholder="Reason for failing (required)…" busy={busy} onSubmit={() => reason.trim() && act({ action: "decide", decision: "fail", reason })} submitLabel="Confirm fail" onCancel={() => setMode("none")} />
          )}
          {mode === "reinspect" && (
            <div className="space-y-2">
              <ReAssign agents={agents} value={reAgent} onChange={setReAgent} />
              <ReasonBox value={reason} onChange={setReason} placeholder="Reason for re-inspection (required)…" busy={busy} onSubmit={() => reAgent && reason.trim() && act({ action: "reinspect", agent_id: reAgent, reason })} submitLabel="Send re-inspection" onCancel={() => setMode("none")} />
            </div>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-slate-400">Read-only — only the FI Coordinator can decide this visit.</p>
      )}
    </div>
  );
}

function Section({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200/70 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <SectionIcon name={icon} className="h-3.5 w-3.5 text-[color:var(--color-brand-teal)]" />
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</p>
      </div>
      {children}
    </div>
  );
}

function Stat({ k, v, danger, mono }: { k: string; v: string; danger?: boolean; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 ring-1 ring-slate-100">
      <p className="text-[9px] font-medium uppercase tracking-wide text-slate-400">{k}</p>
      <p className={`mt-0.5 text-[11px] font-semibold ${danger ? "text-rose-600" : "text-slate-800"} ${mono ? "font-mono tabular-nums" : ""}`}>{v}</p>
    </div>
  );
}

function Thumb({ label, url }: { label: string; url: string | null }) {
  return (
    <div className="text-center">
      <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-sm">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="h-full w-full object-cover" />
        ) : (
          <span className="px-1 text-[10px] text-slate-400">none</span>
        )}
      </div>
      <p className="mt-1 text-[10px] font-medium text-slate-500">{label}</p>
    </div>
  );
}

function ReAssign({ agents, value, onChange }: { agents: FiAgentLite[]; value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700 shadow-sm focus:border-[color:var(--color-brand-sky)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-sky-soft)]"
    >
      <option value="">Re-assign to… (same or new agent)</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.city ? ` · ${a.city}` : ""}
        </option>
      ))}
    </select>
  );
}

function ReasonBox({
  value,
  onChange,
  placeholder,
  busy,
  onSubmit,
  submitLabel,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  busy: boolean;
  onSubmit: () => void;
  submitLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700 shadow-sm focus:border-[color:var(--color-brand-sky)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-sky-soft)]"
      />
      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          disabled={busy || !value.trim()}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40"
          style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-sky), var(--color-brand-navy))" }}
        >
          {submitLabel}
        </button>
        <button onClick={onCancel} disabled={busy} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50">
          Cancel
        </button>
      </div>
    </div>
  );
}
