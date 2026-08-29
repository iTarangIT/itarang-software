"use client";

// E-275 — the "File rejections" + "Recall / Resubmit" block of the admin's
// NBFC Actions card.
//
//  • File rejections: every NBFC that rejected the whole file, with its reason,
//    the admin SLA countdown (same clock/shape as the request chips), and a
//    "Forward to dealer" button — disabled once forwarded, then a line saying
//    who forwarded it (admin or the SLA sweep) and when.
//  • Recall / Resubmit: manual, no SLA. Recall pauses every NBFC on the lead
//    (their APIs 409) until Resubmit.

import { useCallback, useEffect, useState } from "react";

interface Rejection {
  assignmentId: string;
  nbfcName: string | null;
  note: string | null;
  decided_at: string | null;
  rejection_admin_due_at: string | null;
  rejection_forwarded_at: string | null;
  rejection_forward_source: string | null;
}

interface RecallState {
  recalled: boolean;
  canRecall: boolean;
  canResubmit: boolean;
  recalled_at: string | null;
  recall_note: string | null;
  resubmitted_at: string | null;
}

interface Sla {
  enabled: boolean;
  rejectionSlaMinutes: number;
  autoForwardRejection: boolean;
}

/** "1h 12m" / "3d 4h" / "4m 09s" — same shape as the request chips. */
function formatSpan(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-IN");
}

function Countdown({ dueAt, now, sla }: { dueAt: string | null; now: number; sla: Sla | null }) {
  if (!dueAt) {
    if (!sla || !sla.enabled || !sla.autoForwardRejection) return null;
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
        title="This rejection carries no deadline — it needs a manual forward."
      >
        No SLA clock · manual
      </span>
    );
  }
  const remaining = new Date(dueAt).getTime() - now;
  if (!Number.isFinite(remaining)) return null;
  const overdue = remaining <= 0;
  const soon = remaining > 0 && remaining < 15 * 60_000;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        overdue
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : soon
            ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-violet-200 bg-violet-50 text-violet-700"
      }`}
      title={`Deadline ${fmt(dueAt)}`}
    >
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {overdue ? "Auto-forwards to dealer shortly (overdue)" : `Auto-forwards to dealer in ${formatSpan(remaining)}`}
    </span>
  );
}

export default function NbfcFileRejectionsSection({ leadId }: { leadId: string }) {
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [recall, setRecall] = useState<RecallState | null>(null);
  const [sla, setSla] = useState<Sla | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recallOpen, setRecallOpen] = useState(false);
  const [recallNote, setRecallNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/nbfc-requests/rejections?leadId=${leadId}`, { cache: "no-store" });
      const json = await res.json();
      if (json.success) {
        setRejections(json.data.rejections ?? []);
        setRecall(json.data.recall ?? null);
        setSla(json.data.sla ?? null);
        if (json.data.serverNow) {
          const serverMs = new Date(json.data.serverNow).getTime();
          if (Number.isFinite(serverMs)) setClockOffset(serverMs - Date.now());
        }
      }
    } catch {
      // best-effort
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const anyClock = rejections.some((r) => !!r.rejection_admin_due_at && !r.rejection_forwarded_at);
  useEffect(() => {
    if (!anyClock) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const r = setInterval(() => void load(), 60_000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [anyClock, load]);
  const serverNow = now + clockOffset;

  async function post(url: string, key: string, body?: unknown) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const forward = (assignmentId: string) => {
    if (!window.confirm("Forward this rejection (with the NBFC's reason) to the dealer?")) return;
    void post(`/api/admin/nbfc-requests/rejections/${assignmentId}/forward`, `fwd:${assignmentId}`);
  };

  const doRecall = async () => {
    const ok = await post(`/api/admin/lead/${leadId}/recall`, "recall", { note: recallNote.trim() || null });
    if (ok) {
      setRecallOpen(false);
      setRecallNote("");
    }
  };

  const doResubmit = () => {
    if (!window.confirm("Resubmit this file to the NBFC(s) for review?")) return;
    void post(`/api/admin/lead/${leadId}/resubmit`, "resubmit");
  };

  const showRecall = recall && (recall.recalled || recall.canRecall);
  if (rejections.length === 0 && !showRecall && !error) return null;

  return (
    <div className="mb-4 space-y-3">
      {error ? (
        <p className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">{error}</p>
      ) : null}

      {/* Recall / Resubmit */}
      {showRecall ? (
        <div
          className={`rounded-lg border px-3 py-2.5 ${
            recall.recalled ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs">
              {recall.recalled ? (
                <>
                  <span className="font-semibold text-amber-900">Recalled from the NBFC</span>
                  <span className="text-amber-800"> on {fmt(recall.recalled_at)} — NBFC actions are paused.</span>
                  {recall.recall_note ? (
                    <p className="mt-0.5 text-[11px] text-amber-800">Note: {recall.recall_note}</p>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="font-semibold text-slate-700">File is with the NBFC.</span>
                  <span className="text-slate-500"> Recall it to make changes; NBFC actions pause until you resubmit.</span>
                  {recall.resubmitted_at ? (
                    <p className="mt-0.5 text-[11px] text-slate-500">Last resubmitted {fmt(recall.resubmitted_at)}.</p>
                  ) : null}
                </>
              )}
            </div>
            {recall.recalled ? (
              <button
                type="button"
                onClick={doResubmit}
                disabled={busy !== null}
                className="rounded-md bg-[color:var(--color-brand-navy,#1e3a5f)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {busy === "resubmit" ? "Resubmitting…" : "Resubmit to NBFC"}
              </button>
            ) : !recallOpen ? (
              <button
                type="button"
                onClick={() => setRecallOpen(true)}
                disabled={busy !== null}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                Recall file
              </button>
            ) : null}
          </div>
          {recallOpen && !recall.recalled ? (
            <div className="mt-2">
              <textarea
                value={recallNote}
                onChange={(e) => setRecallNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Why is the file being recalled? (optional — shown to the dealer and the NBFC)"
                className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm"
              />
              <div className="mt-1.5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRecallOpen(false);
                    setRecallNote("");
                  }}
                  disabled={busy !== null}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={doRecall}
                  disabled={busy !== null}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                >
                  {busy === "recall" ? "Recalling…" : "Recall file"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* File rejections */}
      {rejections.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-slate-500">File rejections</p>
          <ul className="space-y-1.5">
            {rejections.map((r) => {
              const forwarded = !!r.rejection_forwarded_at;
              const key = `fwd:${r.assignmentId}`;
              return (
                <li key={r.assignmentId} className="rounded-lg border border-rose-200 bg-rose-50/60 px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-rose-200 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">
                        Rejected
                      </span>
                      <span className="text-sm font-semibold text-slate-800">{r.nbfcName ?? "NBFC"}</span>
                      <span className="text-[11px] text-slate-500">{fmt(r.decided_at)}</span>
                      {!forwarded ? <Countdown dueAt={r.rejection_admin_due_at} now={serverNow} sla={sla} /> : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => forward(r.assignmentId)}
                      disabled={forwarded || busy !== null}
                      className="rounded-md bg-[color:var(--color-brand-navy,#1e3a5f)] px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy === key ? "Forwarding…" : forwarded ? "Forwarded" : "Forward to dealer"}
                    </button>
                  </div>
                  <p className="mt-1.5 whitespace-pre-line rounded-md bg-white/70 px-2.5 py-1.5 text-sm text-slate-700">
                    {r.note?.trim() || <span className="text-slate-400">No reason given.</span>}
                  </p>
                  {forwarded ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {r.rejection_forward_source === "system" ? "⚡ Forwarded automatically (SLA)" : "Forwarded by admin"} at{" "}
                      {fmt(r.rejection_forwarded_at)}. The dealer was asked to choose another NBFC.
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-slate-500">
                      The dealer has not been told yet. Forward to relay the reason and ask them to choose another NBFC.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
