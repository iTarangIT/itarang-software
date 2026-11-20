"use client";

// E-390 — the dealer-assignment check queue (20 Nov: decided by iTarang House).
// GET /api/leads/dealer-checks?view=… ; POST /api/leads/dealer-checks/[id]/decide.
// mode "house" — the iTarang House dealer login: Approve / Change / Reject.
// mode "admin" — Admin / Sales Head: view only; the case link opens KYC review.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Row = {
  id: string;
  lead_id: string;
  dealer_id: string;
  dealer_name: string;
  reason_kind: string;
  reason_label: string;
  candidates: Array<{ dealerId: string; name: string }>;
  channel: string;
  initiated_by_name: string | null;
  status: "pending" | "approved" | "changed" | "rejected";
  decided_at: string | null;
  decided_by_name: string | null;
  decision_reason: string | null;
  final_dealer_name: string | null;
  created_at: string;
  customer: string | null;
  reference_id: string | null;
  city: string | null;
  state: string | null;
  kyc_status: string | null;
  payment_method: string | null;
};

function ago(ts: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const STATUS_STYLE: Record<Row["status"], string> = {
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  approved: "bg-emerald-50 text-emerald-800 border-emerald-200",
  changed: "bg-sky-50 text-sky-800 border-sky-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

export default function DealerChecks({ mode }: { mode: "house" | "admin" }) {
  const [view, setView] = useState<"pending" | "decided">("pending");
  const [canDecide, setCanDecide] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/leads/dealer-checks?view=${view}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Could not load the dealer checks");
      setRows(json.data.rows);
      setCanDecide(mode === "house" && !!json.data.canDecide);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the dealer checks");
    }
  }, [view, mode]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["pending", "decided"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold border ${
              view === v ? "bg-[#0047AB] text-white border-[#0047AB]" : "bg-white text-gray-700 border-gray-300"
            }`}
          >
            {v === "pending" ? (canDecide ? "Waiting for you" : "Waiting for iTarang House") : "Decided"}
          </button>
        ))}
      </div>

      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!rows && !error && <p className="text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
          {view === "pending" ? "No dealer waiting to be checked." : "Nothing decided yet."}
        </p>
      )}
      {rows?.map((r) => (
        <CheckCard key={r.id} row={r} onDone={load} canDecide={canDecide} linkToCase={mode === "admin"} />
      ))}
    </div>
  );
}

function CheckCard({
  row,
  onDone,
  canDecide,
  linkToCase,
}: {
  row: Row;
  onDone: () => void;
  canDecide: boolean;
  linkToCase: boolean;
}) {
  const [mode, setMode] = useState<null | "change" | "reject">(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ dealerId: string; name: string }>>([]);
  const [picked, setPicked] = useState<{ dealerId: string; name: string } | null>(null);

  const financeOnly = ["finance", "other_finance"].includes((row.payment_method ?? "").toLowerCase());

  useEffect(() => {
    if (mode !== "change" || picked) return;
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const res = await fetch(
        `/api/leads/dealer-lookup?q=${encodeURIComponent(query)}${financeOnly ? "&finance=1" : ""}`,
        { cache: "no-store" },
      );
      const j = await res.json().catch(() => null);
      if (alive) setResults(j?.success ? j.data?.dealers ?? [] : []);
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, mode, picked, financeOnly]);

  async function decide(decision: "approve" | "change" | "reject") {
    if (decision === "reject" && !reason.trim()) return toast.error("Write the reason for rejecting the dealer.");
    if (decision === "change" && !picked) return toast.error("Pick the correct dealer.");
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/dealer-checks/${row.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          dealer_id: decision === "change" ? picked?.dealerId : undefined,
          reason: reason.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!json?.success) throw new Error(json?.error?.message || "Could not save the decision");
      toast.success(decision === "approve" ? "Dealer approved" : decision === "change" ? "Dealer changed" : "Dealer rejected");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the decision");
    } finally {
      setBusy(false);
    }
  }

  const otherCandidates = row.candidates.filter((c) => c.dealerId !== row.dealer_id);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {linkToCase ? (
            <Link href={`/admin/kyc-review/${encodeURIComponent(row.lead_id)}`} className="text-sm font-semibold text-[#0047AB] hover:underline">
              {row.customer ?? "Customer"} · {row.reference_id ?? row.lead_id}
            </Link>
          ) : (
            <p className="text-sm font-semibold text-gray-900">
              {row.customer ?? "Customer"} · {row.reference_id ?? row.lead_id}
            </p>
          )}
          <p className="text-xs text-gray-500">
            {[row.city, row.state].filter((x) => x && x !== "Unknown").join(", ") || "—"} · {row.payment_method ?? "—"} ·{" "}
            {row.channel === "whatsapp" ? "WhatsApp" : "CRM"} · {ago(row.created_at)}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${STATUS_STYLE[row.status]}`}>
          {row.status === "pending" ? "Waiting" : row.status === "changed" ? "Dealer changed" : row.status[0].toUpperCase() + row.status.slice(1)}
        </span>
      </div>

      <div className="grid gap-2 text-sm md:grid-cols-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Proposed dealer</p>
          <p className="font-semibold text-gray-900">{row.dealer_name}</p>
          <p className="text-xs text-gray-500">{row.dealer_id}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Why it needs a check</p>
          <p className="text-gray-800">{row.reason_label}</p>
          {row.initiated_by_name && <p className="text-xs text-gray-500">by {row.initiated_by_name}</p>}
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Other dealers offered</p>
          <p className="text-gray-800">{otherCandidates.length ? otherCandidates.map((c) => c.name).join(", ") : "—"}</p>
        </div>
      </div>

      {row.status !== "pending" ? (
        <p className="text-xs text-gray-600">
          {row.status === "changed" && row.final_dealer_name ? <>Moved to <b>{row.final_dealer_name}</b>. </> : null}
          {row.decided_by_name ? <>By <b>{row.decided_by_name}</b></> : null}
          {row.decided_at ? ` · ${new Date(row.decided_at).toLocaleString("en-IN")}` : ""}
          {row.decision_reason ? <> — {row.decision_reason}</> : null}
        </p>
      ) : !canDecide ? (
        <p className="text-xs text-amber-800">
          Waiting for iTarang House (dealer@itarang.com) to approve, change or reject the dealer. The file comes to KYC
          review after that.
        </p>
      ) : mode === null ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => decide("approve")}
            className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50">
            {busy ? "Saving…" : "Approve dealer"}
          </button>
          <button type="button" disabled={busy} onClick={() => setMode("change")}
            className="rounded border border-sky-300 bg-white px-4 py-1.5 text-sm font-bold text-sky-800 disabled:opacity-50">
            Change dealer
          </button>
          <button type="button" disabled={busy} onClick={() => setMode("reject")}
            className="rounded border border-red-300 bg-white px-4 py-1.5 text-sm font-bold text-red-700 disabled:opacity-50">
            Reject
          </button>
        </div>
      ) : mode === "change" ? (
        <div className="space-y-2">
          {otherCandidates.length > 0 && !picked && (
            <div className="flex flex-wrap gap-2">
              {otherCandidates.map((c) => (
                <button key={c.dealerId} type="button" onClick={() => setPicked(c)}
                  className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {picked ? (
            <div className="flex items-center justify-between rounded border border-green-200 bg-green-50 px-3 py-2 text-sm">
              <span className="font-semibold text-green-800">{picked.name} <span className="text-xs text-green-700">{picked.dealerId}</span></span>
              <button type="button" className="text-xs text-gray-600" onClick={() => { setPicked(null); setQ(""); }}>Change</button>
            </div>
          ) : (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealer by name or 10-digit mobile"
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              {results.length > 0 && (
                <ul className="max-h-48 overflow-y-auto rounded border border-gray-200 divide-y divide-gray-100">
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
              className="rounded bg-sky-700 px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50">
              {busy ? "Saving…" : "Move to this dealer"}
            </button>
            <button type="button" className="text-xs text-gray-500" onClick={() => { setMode(null); setPicked(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000}
            placeholder="Reason (required) — the sales person who picked the dealer sees this and picks again"
            className="w-full rounded border border-red-300 px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => decide("reject")}
              className="rounded bg-red-600 px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50">
              {busy ? "Rejecting…" : "Reject dealer"}
            </button>
            <button type="button" className="text-xs text-gray-500" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
