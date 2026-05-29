"use client";

/**
 * Field Investigation track panel — Addendum V0.2 §6.3. Assign an agent (opens
 * the 48h SLA), record the visit (GPS supporting evidence + notes), then mark
 * the outcome pass/fail. Owned by the FI Coordinator.
 */
import { useCallback, useEffect, useState } from "react";

type Track = {
  id: string;
  status: string;
  assigned_to: string | null;
  sla_due_at: string | null;
  sla_breached: boolean;
  outcome: string | null;
  agent_notes: string | null;
};

type Resp = { ok: boolean; track: Track | null; can_act?: boolean; error?: string };

const BADGE: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-700",
  assigned: "bg-sky-100 text-sky-700",
  in_progress: "bg-amber-100 text-amber-700",
  pending: "bg-slate-100 text-slate-500",
  failed: "bg-red-100 text-red-700",
  not_applicable: "bg-slate-100 text-slate-500",
};

export default function FiTrackPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [notes, setNotes] = useState("");
  const [expand, setExpand] = useState(false);

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
      setExpand(false);
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
  const terminal = status === "completed" || status === "failed";

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

      {track && (
        <p className="text-[11px] text-slate-500">
          {track.assigned_to ? `Agent: ${track.assigned_to}` : "No agent assigned"}
          {track.outcome ? ` · ${track.outcome}` : ""}
        </p>
      )}
      {track?.sla_breached && !terminal && (
        <p className="text-[11px] text-red-600 font-semibold">⚠ 48-hour SLA breached.</p>
      )}
      {track?.sla_due_at && !terminal && !track.sla_breached && (
        <p className="text-[11px] text-slate-400">SLA due {new Date(track.sla_due_at).toLocaleString("en-IN")}</p>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      {canAct && !terminal && (
        <div className="space-y-2">
          {!track || status === "pending" ? (
            <div className="flex gap-2">
              <input
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                placeholder="Agent name / ID"
                className="flex-1 text-xs border border-slate-200 rounded-md px-2 py-1.5"
              />
              <button
                onClick={() => agent.trim() && act({ action: "assign", assigned_to: agent.trim() })}
                disabled={busy || !agent.trim()}
                className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50"
              >
                Assign
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={() => setExpand((s) => !s)} className="text-[11px] text-[color:var(--color-brand-sky)] underline">
                {expand ? "Hide visit form" : "Record visit"}
              </button>
              {expand && (
                <div className="space-y-2">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    placeholder="Visit notes (address match, observations)…"
                    className="w-full text-xs border border-slate-200 rounded-md px-2 py-1.5"
                  />
                  <button
                    onClick={() => act({ action: "update", agent_notes: notes, address_text_match: true, visited_at: new Date().toISOString() })}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold disabled:opacity-50"
                  >
                    Save visit
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => act({ action: "complete", outcome: "pass", agent_notes: notes || undefined })} disabled={busy} className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50">
                  Complete · Pass
                </button>
                <button onClick={() => act({ action: "complete", outcome: "fail", agent_notes: notes || undefined })} disabled={busy} className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold disabled:opacity-50">
                  Fail
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
