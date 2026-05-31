"use client";

/**
 * Video KYC track panel — Addendum V0.2 §10. Stage-1 track for the acting NBFC.
 * Own mode → Initiate (B2-B) + Record manually. iTarang mode → Initiate hosted
 * Decentro session, poll for the decoded result, then Accept/Reject the card.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Track = {
  id: string;
  mode: "own" | "itarang";
  status: string;
  match_score: string | null;
  liveliness: string | null;
  static_risk: boolean | null;
  prerecorded_risk: boolean | null;
  failure_reason: string | null;
  admin_action: string | null;
};

type Resp = { ok: boolean; track: Track | null; can_act?: boolean; enabled?: boolean; error?: string };

const BADGE: Record<string, string> = {
  verified: "bg-emerald-100 text-emerald-700",
  in_progress: "bg-amber-100 text-amber-700",
  pending: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
  not_applicable: "bg-slate-100 text-slate-500",
};

export default function VkycTrackPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
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

  // Poll while a Decentro session is in flight so the lazy result fetch runs.
  useEffect(() => {
    const t = data?.track;
    const polling = t?.mode === "itarang" && t?.status === "in_progress";
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
  }, [data?.track, load]);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/vkyc/${leadId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; session_url?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.session_url) {
        setSessionUrl(j.session_url);
        window.open(j.session_url, "_blank", "noopener");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canAct = data?.can_act ?? false;
  const enabled = data?.enabled ?? true;
  const track = data?.track ?? null;
  const status = track?.status ?? "pending";

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">Active Video KYC</span>
        {track && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${BADGE[status] ?? "bg-slate-100 text-slate-500"}`}>
            {status.replace(/_/g, " ")}
          </span>
        )}
      </div>

      {track && (
        <p className="text-[11px] text-slate-500">
          {track.mode === "itarang" ? "iTarang · Decentro" : "Own VKYC"}
          {track.match_score ? ` · match ${track.match_score}` : ""}
          {track.liveliness ? ` · liveliness ${track.liveliness}` : ""}
          {track.static_risk ? " · static-risk" : ""}
          {track.prerecorded_risk ? " · prerecorded-risk" : ""}
          {track.failure_reason ? ` · ${track.failure_reason}` : ""}
        </p>
      )}

      {sessionUrl && status === "in_progress" && (
        <a href={sessionUrl} target="_blank" rel="noreferrer" className="text-[11px] text-[color:var(--color-brand-sky)] underline">
          Open session link
        </a>
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

      {canAct && enabled && (
        <div className="flex flex-wrap gap-2">
          {(!track || status === "failed" || status === "not_applicable") && (
            <button onClick={() => post("/initiate")} disabled={busy} className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50">
              {track ? "Re-initiate" : "Initiate VKYC"}
            </button>
          )}
          {track?.mode === "own" && status === "in_progress" && (
            <>
              <button onClick={() => post("/record-manual", { status: "verified" })} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold disabled:opacity-50">
                Record verified
              </button>
              <button onClick={() => post("/record-manual", { status: "failed", failure_reason: "Marked failed by operations" })} disabled={busy} className="px-3 py-1.5 rounded-md border border-red-300 text-red-700 text-xs font-semibold disabled:opacity-50">
                Record failed
              </button>
            </>
          )}
          {status === "verified" && track?.admin_action !== "accepted" && (
            <>
              <button onClick={() => post("/action", { action: "accept" })} disabled={busy} className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50">
                Accept
              </button>
              <button onClick={() => post("/action", { action: "reject", notes: "Rejected on review" })} disabled={busy} className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold disabled:opacity-50">
                Reject
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
