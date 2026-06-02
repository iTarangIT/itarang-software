"use client";

/**
 * Passive Video KYC Review Screen — Addendum V0.3.1 §11.3.4 / §11.3.5.
 *
 * Renders the customer's submitted passive-liveness result for NBFC review:
 * the Session Video (§11.3.4, hidden if the provider didn't yield a clip),
 * the Liveness & Spoof signals (confidence / liveliness / static & prerecorded
 * risk), the derived auto-flags (§11.3.5 — surfaced, never auto-failing), the
 * collapsible raw provider payload (audit), and the Decision panel
 * (Accept / Reject, reason required on Reject) wired to
 * POST /api/nbfc/vkyc/[leadId]/action. Read-only once a decision is recorded.
 */
import { useState } from "react";

export interface VkycReviewTrack {
  status: string;
  match_score: string | null;
  liveliness: string | null;
  static_risk: boolean | null;
  prerecorded_risk: boolean | null;
  failure_reason: string | null;
  session_video_url: string | null;
  geo_location: unknown;
  provider_raw_payload: unknown;
  admin_action: string | null;
  admin_action_notes: string | null;
}

type IconName = "video" | "shield" | "flag" | "doc";

function SectionIcon({ name, className }: { name: IconName; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "video":
      return (<svg {...common}><path d="m22 8-6 4 6 4V8Z" /><rect x="2" y="6" width="14" height="12" rx="2" /></svg>);
    case "shield":
      return (<svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>);
    case "flag":
      return (<svg {...common}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>);
    case "doc":
      return (<svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>);
  }
}

function isRisk(v: boolean | null): boolean {
  return v === true;
}

/**
 * A failure that's an input-quality / transport reject — the provider never
 * scored liveness — rather than a genuine "not live" verdict. These attempts
 * have no real liveness/confidence/risk results, so we must not surface them as
 * a liveness failure; the customer just needs to re-record.
 */
function isSystemError(reason: string | null): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return (
    r.includes("unsanitized") ||
    r.includes("could not be completed") ||
    r.includes("result fetch failed") ||
    r.includes("authentication") ||
    r.includes("resolution") ||
    r.includes("invalid video") ||
    r.includes("lower than expected") ||
    r.includes("minimum of") ||
    r.includes("too large") ||
    r.includes("no video")
  );
}

/** A human-friendly hint for the common input-quality rejects. */
function systemErrorHint(reason: string | null): string {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("resolution") || r.includes("800") || r.includes("lower than expected") || r.includes("minimum of")) {
    return "The clip was below the provider's 800×600 minimum. Ask the customer to re-record in good light with the phone held steady and the face filling the frame.";
  }
  return "The provider couldn't score this attempt. Re-send the link so the customer can record again.";
}

type Flag = { key: string; severity: "red" | "warn"; label: string };

function buildFlags(t: VkycReviewTrack, systemErr: boolean): Flag[] {
  const flags: Flag[] = [];
  // Input/transport reject — provider never scored liveness. One warn, no red
  // liveness/risk flags (there are no real signals to flag).
  if (systemErr) {
    flags.push({ key: "system", severity: "warn", label: "Attempt not scored — re-record needed (not a liveness failure)" });
    return flags;
  }
  const live = (t.liveliness ?? "").toLowerCase();
  if (t.status !== "in_progress" && t.status !== "pending") {
    if (live && live !== "yes") flags.push({ key: "liveliness", severity: "red", label: "Liveness not confirmed by the provider" });
    if (isRisk(t.static_risk)) flags.push({ key: "static", severity: "red", label: "Static-image (photo-of-photo) risk detected" });
    if (isRisk(t.prerecorded_risk)) flags.push({ key: "prerecorded", severity: "red", label: "Pre-recorded / replayed video risk detected" });
  }
  return flags;
}

export default function VkycReviewPanel({
  leadId,
  track,
  mode,
  canAct,
  onChanged,
}: {
  leadId: string;
  track: VkycReviewTrack;
  mode: string;
  canAct: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisionMode, setDecisionMode] = useState<"none" | "reject">("none");
  const [reason, setReason] = useState("");

  const decided = track.admin_action === "accepted" || track.admin_action === "rejected";
  const systemErr = track.status === "failed" && isSystemError(track.failure_reason);
  const flags = buildFlags(track, systemErr);
  const live = (track.liveliness ?? "").toLowerCase();
  const livenessOk = live === "yes";
  // Decentro's PASSIVE liveness endpoint only returns a liveness verdict +
  // confidence — static/pre-recorded risk are ACTIVE-mode (Farsight) signals,
  // so we don't render those tiles in passive mode (they'd be perpetually "—").
  const isPassive = mode === "passive";

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/vkyc/${leadId}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDecisionMode("none");
      setReason("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-slate-200/80 bg-slate-50/60 p-3">
      {/* Session video (§11.3.4 — conditional; hidden when no clip was captured) */}
      {track.session_video_url ? (
        <Section icon="video" title="Session video · customer's recorded clip">
          <video
            controls
            playsInline
            preload="metadata"
            src={track.session_video_url}
            className="w-full rounded-lg border border-slate-200 bg-black shadow-sm"
            style={{ maxHeight: 320 }}
          />
          <a
            href={track.session_video_url}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 inline-flex text-[10px] font-semibold text-[color:var(--color-brand-sky)] underline-offset-2 hover:underline"
          >
            Open video in new tab →
          </a>
        </Section>
      ) : (
        <Section icon="video" title="Session video">
          <p className="text-[11px] text-slate-400">No retrievable video for this attempt.</p>
        </Section>
      )}

      {/* Why it failed — surfaced plainly (the reviewer shouldn't have to dig
          into the raw payload). System/quality rejects read amber (re-record,
          not a liveness failure); genuine "not live" verdicts read rose. */}
      {track.status === "failed" && track.failure_reason && (
        <div className={`rounded-xl px-3 py-2.5 text-[11px] ring-1 ${systemErr ? "bg-amber-50 text-amber-800 ring-amber-100" : "bg-rose-50 text-rose-700 ring-rose-100"}`}>
          <p className="font-bold">{systemErr ? "Attempt could not be scored" : "Liveness failed"}</p>
          <p className="mt-0.5 font-medium">{track.failure_reason}</p>
          {systemErr && <p className="mt-1 text-amber-700">{systemErrorHint(track.failure_reason)}</p>}
        </div>
      )}

      {/* Liveness & spoof signals (§11.3.4) */}
      <Section icon="shield" title="Liveness &amp; spoof signals">
        {systemErr ? (
          <p className="text-[11px] text-slate-400">Not scored — the provider rejected the clip before evaluating liveness.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Stat k="Confidence" v={track.match_score != null ? `${track.match_score}%` : "—"} mono />
            <Stat k="Liveliness" v={track.liveliness ? (livenessOk ? "Yes ✓" : track.liveliness) : "—"} danger={!!track.liveliness && !livenessOk} />
            {!isPassive && (
              <>
                <Stat k="Static-image risk" v={track.static_risk == null ? "—" : isRisk(track.static_risk) ? "Detected" : "Clear ✓"} danger={isRisk(track.static_risk)} />
                <Stat k="Pre-recorded risk" v={track.prerecorded_risk == null ? "—" : isRisk(track.prerecorded_risk) ? "Detected" : "Clear ✓"} danger={isRisk(track.prerecorded_risk)} />
              </>
            )}
          </div>
        )}
        {isPassive && !systemErr && (
          <p className="mt-1.5 text-[10px] text-slate-400">Static-image &amp; pre-recorded-risk are active-VKYC signals — not provided by the passive engine.</p>
        )}
      </Section>

      {/* Auto-flags (§11.3.5 — review only, never auto-fail) */}
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

      {/* Raw provider payload (audit) */}
      {track.provider_raw_payload != null && (
        <details className="rounded-xl border border-slate-200/70 bg-white p-3">
          <summary className="flex cursor-pointer items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <SectionIcon name="doc" className="h-3.5 w-3.5 text-[color:var(--color-brand-teal)]" />
            Raw provider payload
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-900 p-2.5 text-[10px] leading-relaxed text-slate-100">
            {JSON.stringify(track.provider_raw_payload, null, 2)}
          </pre>
        </details>
      )}

      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 ring-1 ring-rose-100">{error}</p>}

      {/* Decision panel */}
      {decided ? (
        <div className={`rounded-xl p-3 ring-1 ${track.admin_action === "accepted" ? "bg-emerald-50 ring-emerald-100" : "bg-rose-50 ring-rose-100"}`}>
          <div className="flex items-center gap-2">
            <span className={`grid h-7 w-7 place-items-center rounded-full text-white ${track.admin_action === "accepted" ? "bg-emerald-500" : "bg-rose-500"}`}>
              {track.admin_action === "accepted" ? "✓" : "✕"}
            </span>
            <div>
              <p className="text-xs font-bold text-slate-800">Video KYC {track.admin_action === "accepted" ? "accepted" : "rejected"}</p>
              {track.admin_action_notes && <p className="text-[11px] text-slate-500">{track.admin_action_notes}</p>}
            </div>
          </div>
        </div>
      ) : canAct ? (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Reviewer decision</p>
          {decisionMode === "none" && (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => act({ action: "accept" })}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40"
              >
                ✓ Accept
              </button>
              <button
                onClick={() => setDecisionMode("reject")}
                disabled={busy}
                className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:opacity-40"
              >
                ✕ Reject
              </button>
            </div>
          )}
          {decisionMode === "reject" && (
            <ReasonBox
              value={reason}
              onChange={setReason}
              placeholder="Reason for rejecting (required)…"
              busy={busy}
              onSubmit={() => reason.trim() && act({ action: "reject", notes: reason })}
              submitLabel="Confirm reject"
              onCancel={() => { setDecisionMode("none"); setReason(""); }}
            />
          )}
        </div>
      ) : (
        <p className="text-[11px] text-slate-400">Read-only — only Operations / NBFC Admin can decide Video KYC.</p>
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
