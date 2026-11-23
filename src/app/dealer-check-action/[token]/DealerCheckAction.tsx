"use client";

// The act-on-it page behind the dealer-check email / WhatsApp link.
// GET/POST /api/public/dealer-check-action/<token>.

import { useCallback, useEffect, useState } from "react";

type Check = {
  you: string | null;
  status: "pending" | "approved" | "changed" | "rejected";
  customer: string;
  reference: string;
  place: string | null;
  payment: string | null;
  dealer: { id: string; name: string };
  reason: string;
  initiatedBy: string | null;
  otherDealers: Array<{ dealerId: string; name: string }>;
  decided: { by: string | null; at: string | null; note: string | null; finalDealer: string | null } | null;
};

const DONE_TEXT: Record<string, string> = {
  approved: "Dealer approved",
  changed: "Dealer changed",
  rejected: "Dealer rejected",
};

export default function DealerCheckAction({ token }: { token: string }) {
  const api = `/api/public/dealer-check-action/${encodeURIComponent(token)}`;
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "change" | "reject">(null);
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ dealerId: string; name: string }>>([]);
  const [picked, setPicked] = useState<{ dealerId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(api, { cache: "no-store" });
    const j = await res.json().catch(() => null);
    if (!j?.success) {
      setError(j?.error?.message || "This link could not be opened.");
      return;
    }
    setCheck(j.data);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (mode !== "change" || picked) return;
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const res = await fetch(`${api}?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (alive) setResults(j?.success ? j.data?.dealers ?? [] : []);
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, mode, picked, api]);

  async function decide(decision: "approve" | "change" | "reject") {
    if (decision === "reject" && !reason.trim()) return setError("Write the reason for rejecting the dealer.");
    if (decision === "change" && !picked) return setError("Pick the correct dealer.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, dealer_id: picked?.dealerId, reason: reason.trim() || undefined }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.error?.message || "Could not save the decision");
      setDone(
        decision === "approve"
          ? "Dealer approved. The file goes on to the iTarang KYC review — the others on the alert list have been told."
          : decision === "change"
            ? `Moved to ${picked?.name}. The others on the alert list have been told.`
            : "Dealer rejected. The sales person will pick the dealer again — the others on the alert list have been told.",
      );
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the decision");
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (error && !check) return <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>;
  if (!check) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div>
        <h1 className="text-lg font-bold text-gray-900">
          {check.customer} · {check.reference}
        </h1>
        <p className="text-xs text-gray-500">
          {[check.place, check.payment].filter(Boolean).join(" · ") || "—"}
          {check.you ? ` · signed link for ${check.you}` : ""}
        </p>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Proposed dealer</p>
          <p className="font-semibold text-gray-900">{check.dealer.name}</p>
          <p className="text-xs text-gray-500">{check.dealer.id}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Why it needs a check</p>
          <p className="text-gray-800">{check.reason}</p>
          {check.initiatedBy && <p className="text-xs text-gray-500">by {check.initiatedBy}</p>}
        </div>
      </div>

      {done && <p className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{done}</p>}

      {check.status !== "pending" ? (
        !done && (
          <p className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
            <b>{DONE_TEXT[check.status] ?? "Already decided"}</b>
            {check.decided?.by ? <> by <b>{check.decided.by}</b></> : null}
            {check.decided?.at ? ` · ${new Date(check.decided.at).toLocaleString("en-IN")}` : ""}
            {check.decided?.finalDealer && check.status === "changed" ? <> — moved to {check.decided.finalDealer}</> : null}
            {check.decided?.note ? <> — {check.decided.note}</> : null}
            . No action needed.
          </p>
        )
      ) : mode === null ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => decide("approve")}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {busy ? "Saving…" : "Approve dealer"}
          </button>
          <button type="button" disabled={busy} onClick={() => setMode("change")}
            className="rounded-lg border border-sky-300 px-4 py-2 text-sm font-bold text-sky-800">
            Change dealer
          </button>
          <button type="button" disabled={busy} onClick={() => setMode("reject")}
            className="rounded-lg border border-red-300 px-4 py-2 text-sm font-bold text-red-700">
            Reject
          </button>
        </div>
      ) : mode === "change" ? (
        <div className="space-y-2">
          {check.otherDealers.length > 0 && !picked && (
            <div className="flex flex-wrap gap-2">
              {check.otherDealers.map((c) => (
                <button key={c.dealerId} type="button" onClick={() => setPicked(c)}
                  className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {picked ? (
            <div className="flex items-center justify-between rounded border border-green-200 bg-green-50 px-3 py-2 text-sm">
              <span className="font-semibold text-green-800">{picked.name}</span>
              <button type="button" className="text-xs text-gray-600" onClick={() => { setPicked(null); setQ(""); }}>Change</button>
            </div>
          ) : (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealer by name or 10-digit mobile"
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              {results.length > 0 && (
                <ul className="max-h-48 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-200">
                  {results.map((d) => (
                    <li key={d.dealerId}>
                      <button type="button" onClick={() => setPicked(d)} className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50">
                        {d.name} <span className="text-xs text-gray-500">{d.dealerId}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Note (optional)"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button type="button" disabled={busy || !picked} onClick={() => decide("change")}
              className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              {busy ? "Saving…" : "Move to this dealer"}
            </button>
            <button type="button" className="text-xs text-gray-500" onClick={() => { setMode(null); setPicked(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000}
            placeholder="Reason (required) — the sales person who picked the dealer sees this and picks again"
            className="w-full rounded border border-red-300 px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => decide("reject")}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              {busy ? "Rejecting…" : "Reject dealer"}
            </button>
            <button type="button" className="text-xs text-gray-500" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}

      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <p className="text-[11px] text-gray-400">The first person to act decides. Everyone else on the alert list is told who acted.</p>
    </div>
  );
}
