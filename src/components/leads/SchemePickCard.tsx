"use client";

/**
 * E-393 (23 Nov 2026, Battery Pool) — "sales_head can choose the NBFC scheme
 * before submitting the lead". Admin / sales head pick the lender + loan
 * product; the file goes there when Step 4 opens (beats the routing rules
 * while the BRE allows it). Renders nothing when the API refuses (other roles).
 */
import { useCallback, useEffect, useState } from "react";

type Option = { nbfcId: number; loanProductId: number; label: string; detail: string };
type State = {
  ok: boolean;
  current: {
    nbfc_id: number;
    loan_product_id: number;
    label: string;
    still_eligible: boolean;
    picked_by_name: string | null;
    picked_at: string;
    channel: string;
  } | null;
  options: Option[];
  locked: boolean;
  can_pick: boolean;
};

export default function SchemePickCard({ leadId }: { leadId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}/scheme-pick`, { cache: "no-store" });
    const j = (await res.json().catch(() => null)) as State | null;
    setState(res.ok && j?.ok ? j : null);
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(clear: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const [nbfc_id, loan_product_id] = choice.split(":").map(Number);
      const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}/scheme-pick`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(clear ? { clear: true } : { nbfc_id, loan_product_id }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; label?: string | null };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setMsg(clear ? "Cleared — the routing rules decide." : `Saved: ${j.label}`);
      setChoice("");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  // Nothing to show to a role that cannot pick and when nothing was picked.
  if (!state.can_pick && !state.current) return null;

  return (
    <section className="mb-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">NBFC scheme</h3>
        {state.locked ? <span className="text-[11px] text-slate-500">File is already with a lender</span> : null}
      </div>
      {state.current ? (
        <p className="mt-1 text-xs text-slate-600">
          Picked: <b>{state.current.label}</b>
          {state.current.picked_by_name ? ` by ${state.current.picked_by_name}` : ""} (
          {new Date(state.current.picked_at).toLocaleString("en-IN")}, {state.current.channel})
          {!state.current.still_eligible ? (
            <span className="text-amber-700"> — no longer fits this lead; the routing rules will decide.</span>
          ) : null}
        </p>
      ) : (
        <p className="mt-1 text-xs text-slate-500">
          No scheme picked — the NBFC routing rules choose the lender when Step 4 opens.
        </p>
      )}
      {state.can_pick ? (
        state.options.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            No scheme fits this lead yet (check the loan amount, city and product category).
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={busy}
              className="min-w-[18rem] rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">Choose lender + scheme…</option>
              {state.options.map((o) => (
                <option key={`${o.nbfcId}:${o.loanProductId}`} value={`${o.nbfcId}:${o.loanProductId}`}>
                  {o.label} · {o.detail}
                </option>
              ))}
            </select>
            <button
              onClick={() => save(false)}
              disabled={busy || !choice}
              className="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save scheme"}
            </button>
            {state.current ? (
              <button
                onClick={() => save(true)}
                disabled={busy}
                className="text-xs text-slate-500 hover:underline disabled:opacity-50"
              >
                Clear (use routing rules)
              </button>
            ) : null}
          </div>
        )
      ) : null}
      {msg ? <p className="mt-2 text-xs text-slate-600">{msg}</p> : null}
    </section>
  );
}
