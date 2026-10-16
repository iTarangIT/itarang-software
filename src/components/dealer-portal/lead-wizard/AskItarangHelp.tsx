"use client";

// ID 183 — the dealer's "Ask iTarang to help" on one of his files. While it is
// on, Admin / Sales Head may work the file for him from the CRM at once
// (otherwise only after 1 working day with no dealer action). The file stays
// his; every step iTarang takes is recorded and he is told — the "Done by
// <name> for <dealer>" lines are listed here, the file's own timeline. Renders
// nothing for a login that is not the file's dealer (the API answers 403).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface HistoryRow {
  at: string;
  line: string;
  step: string | null;
}

interface AskState {
  open: { requestedAt: string } | null;
  unavailable?: string;
  history?: HistoryRow[];
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
}

export default function AskItarangHelp({ leadId }: { leadId: string }) {
  const [state, setState] = useState<AskState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/lead/${encodeURIComponent(leadId)}/assist-request`, { cache: "no-store" });
      if (!res.ok) return setState(null);
      const json = await res.json();
      setState(json.success ? json.data : null);
    } catch {
      setState(null);
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;
  const history = state.history ?? [];

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/lead/${encodeURIComponent(leadId)}/assist-request`, {
        method: state?.open ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: state?.open ? undefined : JSON.stringify({}),
      });
      const json = await res.json().catch(() => null);
      if (!json?.success) throw new Error(json?.error?.message || "Could not update");
      setState((prev) => ({ ...json.data, history: prev?.history ?? [] }));
      toast.success(json.data.open ? "iTarang has been asked to help on this file" : "Help request withdrawn");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update");
    } finally {
      setBusy(false);
    }
  }

  if (state.unavailable && history.length === 0) return null;

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm">
      {!state.unavailable && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-gray-700">
            {state.open
              ? "You asked iTarang to help on this file. The iTarang team may upload documents, send the consent code and submit for you. The file stays yours."
              : "Stuck on this file? Ask the iTarang team to help — they can work it for you; the file stays yours."}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={toggle}
            className="rounded-lg border border-gray-300 px-3 py-1.5 font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60"
          >
            {state.open ? "Stop asking for help" : "Ask iTarang to help"}
          </button>
        </div>
      )}
      {history.length > 0 && (
        <div className={state.unavailable ? "" : "mt-3 border-t border-gray-100 pt-2"}>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Done for you by iTarang</div>
          <ul className="space-y-0.5 text-xs text-gray-700">
            {history.map((h, i) => (
              <li key={`${h.at}-${i}`}>
                <span className="text-gray-500">{when(h.at)}</span> · {h.line}
                {h.step ? `: ${h.step}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
