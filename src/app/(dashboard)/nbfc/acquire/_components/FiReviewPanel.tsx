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
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      {/* Location evidence */}
      <Section title="Location evidence">
        <Row k="Stated (geocoded)" v={track.stated_lat && track.stated_lng ? `${track.stated_lat}, ${track.stated_lng}` : "not geocoded"} />
        <Row k="Captured at visit" v={captured} />
        <Row
          k="Distance from address"
          v={track.distance_from_address_m != null ? `${track.distance_from_address_m} m` : "not computable"}
          danger={track.distance_from_address_m != null && Number(track.distance_from_address_m) > 50}
        />
        <Row k="GPS accuracy" v={track.gps_accuracy_m != null ? `±${track.gps_accuracy_m} m` : "—"} />
        {mapHref && (
          <a href={mapHref} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-[color:var(--color-brand-sky)] underline">
            Open captured point in Maps →
          </a>
        )}
      </Section>

      {/* Agent identity */}
      <Section title="Agent identity">
        <div className="flex gap-4">
          <Thumb label="Reference" url={agent?.reference_photo_url ?? null} />
          <Thumb label="Field selfie" url={selfie?.image_url ?? null} />
        </div>
        <p className="text-[10px] text-slate-400 mt-1">Visual comparison only — no automated face match (§10.7).</p>
      </Section>

      {/* Evidence photos */}
      <Section title="Evidence photos">
        <div className="grid grid-cols-3 gap-2">
          {evidencePhotos.map((p) => (
            <a key={p.id} href={p.image_url} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.image_url} alt={p.photo_type} className="w-full h-20 object-cover rounded-md border border-slate-200" />
              <p className="text-[9px] text-slate-500 mt-0.5">
                {PHOTO_LABELS[p.photo_type] ?? p.photo_type}
                {!p.watermark_applied && <span className="text-amber-600"> · no watermark</span>}
              </p>
            </a>
          ))}
          {evidencePhotos.length === 0 && <p className="text-[11px] text-slate-400">No photos.</p>}
        </div>
      </Section>

      {/* Field observation */}
      <Section title="Agent's field observation">
        <Row k="Address match" v={track.address_match ?? "—"} danger={track.address_match === "no" || track.address_match === "partial"} />
        {track.address_match_notes && <p className="text-[11px] text-slate-500">“{track.address_match_notes}”</p>}
        <Row k="Customer present" v={track.customer_present == null ? "—" : track.customer_present ? "Yes" : "No"} danger={track.customer_present === false} />
        {track.customer_present_notes && <p className="text-[11px] text-slate-500">“{track.customer_present_notes}”</p>}
        {track.agent_notes && <p className="text-[11px] text-slate-500 mt-1">Notes: {track.agent_notes}</p>}
      </Section>

      {/* Auto-flags */}
      {flags.length > 0 && (
        <Section title="Auto-flags (review, never auto-fail)">
          <ul className="space-y-1">
            {flags.map((f) => (
              <li key={f.key} className={`text-[11px] flex items-start gap-1.5 ${f.severity === "red" ? "text-red-600" : "text-amber-600"}`}>
                <span>{f.severity === "red" ? "⛔" : "⚠"}</span>
                <span>{f.label}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      {/* Decision panel */}
      {decided ? (
        <div className="rounded-md border border-slate-200 bg-white p-2.5">
          <p className="text-xs font-semibold text-slate-800">
            Decision: <span className={track.status === "passed" ? "text-emerald-700" : "text-red-700"}>{track.status === "passed" ? "Passed" : "Failed"}</span>
          </p>
          {track.decision_reason && <p className="text-[11px] text-slate-500 mt-0.5">{track.decision_reason}</p>}
          {canReopen && mode !== "reopen" && (
            <button onClick={() => setMode("reopen")} className="mt-2 text-[11px] font-semibold text-[color:var(--color-brand-sky)] underline">
              Reopen decision
            </button>
          )}
          {canAct && mode !== "reinspect" && (
            <button onClick={() => setMode("reinspect")} className="mt-2 ml-3 text-[11px] font-semibold text-amber-700 underline">
              Request re-inspection
            </button>
          )}
          {mode === "reopen" && (
            <ReasonBox value={reason} onChange={setReason} placeholder="Reason for reopening…" busy={busy} onSubmit={() => reason.trim() && act({ action: "reopen", reason })} submitLabel="Confirm reopen" onCancel={() => setMode("none")} />
          )}
        </div>
      ) : canAct ? (
        <div className="rounded-md border border-slate-200 bg-white p-2.5 space-y-2">
          <p className="text-xs font-semibold text-slate-800">Decision</p>
          {mode === "none" && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => act({ action: "decide", decision: "pass" })} disabled={busy} className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50">
                Pass
              </button>
              <button onClick={() => setMode("fail")} disabled={busy} className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold disabled:opacity-50">
                Fail
              </button>
              <button onClick={() => setMode("reinspect")} disabled={busy} className="px-3 py-1.5 rounded-md border border-amber-400 text-amber-700 text-xs font-semibold disabled:opacity-50">
                Request re-inspection
              </button>
            </div>
          )}
          {mode === "fail" && (
            <ReasonBox value={reason} onChange={setReason} placeholder="Reason for failing (required)…" busy={busy} onSubmit={() => reason.trim() && act({ action: "decide", decision: "fail", reason })} submitLabel="Confirm fail" onCancel={() => setMode("none")} />
          )}
          {mode === "reinspect" && (
            <div className="space-y-2">
              <select value={reAgent} onChange={(e) => setReAgent(e.target.value)} className="w-full text-xs border border-slate-300 rounded-md px-2 py-1.5">
                <option value="">Re-assign to… (same or new agent)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.city ? ` · ${a.city}` : ""}
                  </option>
                ))}
              </select>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div className="flex justify-between text-[11px]">
      <span className="text-slate-500">{k}</span>
      <span className={danger ? "text-red-600 font-semibold" : "text-slate-800"}>{v}</span>
    </div>
  );
}

function Thumb({ label, url }: { label: string; url: string | null }) {
  return (
    <div className="text-center">
      <div className="w-20 h-20 rounded-md bg-slate-100 overflow-hidden border border-slate-200 flex items-center justify-center">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="w-full h-full object-cover" />
        ) : (
          <span className="text-[10px] text-slate-400 px-1">none</span>
        )}
      </div>
      <p className="text-[10px] text-slate-500 mt-0.5">{label}</p>
    </div>
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
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} placeholder={placeholder} className="w-full text-xs border border-slate-300 rounded-md px-2 py-1.5" />
      <div className="flex gap-2">
        <button onClick={onSubmit} disabled={busy || !value.trim()} className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50">
          {submitLabel}
        </button>
        <button onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs font-semibold">
          Cancel
        </button>
      </div>
    </div>
  );
}
