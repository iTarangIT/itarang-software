"use client";

/**
 * Passive Video KYC track panel — Addendum V0.3.1 §11.
 *
 * The operator sends the customer a single-use link (SMS / Email / WhatsApp) to
 * record a short LIVE selfie video; Decentro's passive liveness engine scores
 * it. The panel polls for the result while the link is outstanding, then the
 * operator Accepts / Rejects. Replaces the old Decentro Active (hosted-session)
 * VKYC flow.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import VkycReviewPanel from "./VkycReviewPanel";
import TrackHistoryBar, { type HistoryBarEntry } from "./TrackHistoryBar";

type Track = {
  id: string;
  vkyc_ref: string;
  mode: string;
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
  admin_action_at: string | null;
  link_channel: string | null;
};

type VkycAttempt = {
  id: string;
  status: string;
  provider_raw_status: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type Resp = { ok: boolean; track: Track | null; history?: VkycAttempt[]; can_act?: boolean; enabled?: boolean; error?: string };

const RUN_LABEL: Record<string, { label: string; tone: HistoryBarEntry["tone"] }> = {
  verified: { label: "Verified", tone: "pass" },
  failed: { label: "Liveness failed", tone: "fail" },
  in_progress: { label: "Link sent · awaiting", tone: "info" },
};

/** Build the Video KYC history timeline: each run, plus the reviewer's decision. */
function buildVkycHistory(track: Track | null, attempts: VkycAttempt[]): HistoryBarEntry[] {
  const entries: HistoryBarEntry[] = [];
  // Reviewer decision sits on top (most recent action on the track).
  if (track?.admin_action) {
    const accepted = track.admin_action === "accepted";
    entries.push({
      key: "decision",
      label: accepted ? "Reviewer accepted" : "Reviewer rejected",
      tone: accepted ? "pass" : "fail",
      detail: track.admin_action_notes,
      at: track.admin_action_at,
    });
  }
  // Runs newest-first; run numbers count from the oldest (Run 1).
  attempts.forEach((a, idx) => {
    const meta = RUN_LABEL[a.status] ?? { label: a.status.replace(/_/g, " "), tone: "neutral" as const };
    entries.push({
      key: a.id,
      label: `Run ${idx + 1} · ${meta.label}`,
      tone: meta.tone,
      detail: a.provider_raw_status ? a.provider_raw_status.replace(/_/g, " ") : null,
      at: a.updated_at ?? a.created_at,
    });
  });
  // Decision first, then runs newest → oldest.
  const decision = entries[0]?.key === "decision" ? [entries.shift()!] : [];
  return [...decision, ...entries.reverse()];
}

type Channel = "email" | "sms" | "whatsapp";

const BADGE: Record<string, string> = {
  verified: "bg-emerald-100 text-emerald-700",
  in_progress: "bg-amber-100 text-amber-700",
  pending: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
  not_applicable: "bg-slate-100 text-slate-500",
};

const CHANNEL_LABEL: Record<Channel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };

export default function VkycTrackPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [channel, setChannel] = useState<Channel>("email");
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/vkyc/${leadId}`);
      const j = (await res.json()) as Resp;
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the link is outstanding so the customer's submission lands.
  useEffect(() => {
    const polling = data?.track?.status === "in_progress";
    if (polling && !pollRef.current) {
      pollRef.current = setInterval(() => void load(), 5000);
    }
    if (!polling && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [data?.track?.status, load]);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/vkyc/${leadId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; link_url?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.link_url) setLinkUrl(j.link_url);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const canAct = data?.can_act ?? false;
  const enabled = data?.enabled ?? true;
  const track = data?.track ?? null;
  const status = track?.status ?? "pending";
  // The capture link = origin + /vkyc/<ref>. Prefer the value the initiate call
  // returned; otherwise derive it from the track's ref.
  const effLink =
    linkUrl ??
    (track?.vkyc_ref && typeof window !== "undefined" ? `${window.location.origin}/vkyc/${track.vkyc_ref}` : null);

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">Passive Video KYC</span>
        {track && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${BADGE[status] ?? "bg-slate-100 text-slate-500"}`}>
            {status.replace(/_/g, " ")}
          </span>
        )}
      </div>

      {track && (
        <p className="text-[11px] text-slate-500">
          Passive liveness · Decentro
          {track.link_channel ? ` · link sent via ${CHANNEL_LABEL[track.link_channel as Channel] ?? track.link_channel}` : ""}
        </p>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      {canAct && !enabled && (
        <p className="text-[11px] text-slate-500">
          Not opted in for this lead. Enable Video KYC in{" "}
          <a href="/nbfc/settings" className="underline text-[color:var(--color-brand-sky)]">
            Settings → Service Opt-In
          </a>
          .
        </p>
      )}

      {/* Outstanding link — show the capture URL + copy while we wait. */}
      {status === "in_progress" && effLink && (
        <div className="flex items-center gap-2 rounded-md bg-[var(--brand-sky-soft,#eff6ff)] px-2.5 py-1.5">
          <span className="truncate text-[11px] text-[color:var(--color-brand-sky)]">{effLink}</span>
          <button
            onClick={() => copyLink(effLink)}
            className="ml-auto shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      {canAct && enabled && (
        <div className="space-y-2">
          {/* Channel picker + send (initial, failed, re-send) */}
          {(!track || status === "failed" || status === "not_applicable" || status === "in_progress") && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
                {(["email", "sms", "whatsapp"] as Channel[]).map((c) => (
                  <button
                    key={c}
                    onClick={() => setChannel(c)}
                    className={`px-2.5 py-1 text-[11px] font-semibold ${
                      channel === c ? "bg-[color:var(--color-brand-navy)] text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {CHANNEL_LABEL[c]}
                  </button>
                ))}
              </div>
              <button
                onClick={() => post("/initiate", { channel })}
                disabled={busy}
                className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50"
              >
                {busy ? "Sending…" : status === "in_progress" ? `Resend via ${CHANNEL_LABEL[channel]}` : `Send VKYC link via ${CHANNEL_LABEL[channel]}`}
              </button>
            </div>
          )}

          {status === "in_progress" && (
            <p className="text-[11px] text-slate-400">Waiting for the customer to record their video…</p>
          )}
        </div>
      )}

      {/* Premium §11.3.4 review screen — video + signals + decision, once a
          result has landed (or a clip was captured for an errored attempt). */}
      {track && (status === "verified" || status === "failed" || !!track.session_video_url) && (
        <VkycReviewPanel leadId={leadId} track={track} mode={track.mode} canAct={canAct} onChanged={() => void load()} />
      )}

      {/* History bar — every VKYC run + the reviewer's decision. */}
      <TrackHistoryBar title="Video KYC history" entries={buildVkycHistory(track, data?.history ?? [])} />
    </div>
  );
}
