"use client";

/**
 * Transaction history — the money ledger (M14).
 *
 * The reconciliation banner is the point of this screen, not the table. Its AC:
 *
 *   "ledger net for CLOSED deals == dashboard Total Margin Earned"
 *
 * Those two numbers come from independent places — what MOVED (settlements) and
 * what was AGREED (deal_line_locks, frozen and fill-once). If they ever disagree,
 * a report is lying and someone must know TODAY, not at the next audit. So the
 * banner is shown whether it passes or fails, rather than only surfacing on
 * failure: a silent green check that nobody has seen is indistinguishable from a
 * check that never ran.
 */

import { useEffect, useState } from "react";

import { inr } from "@/lib/buyback/format";

interface Row {
  txn: string;
  request_no: string;
  counterparty: string;
  direction: "IN" | "OUT";
  method: string;
  txn_ref: string | null;
  proof_s3: string | null;
  txn_date: string;
  recorded_by: string | null;
  amount: string;
}

interface Data {
  rows: Row[];
  totals: { in: number; out: number; net: number };
  reconciliation: {
    scope: string;
    ledger_net: number;
    /** Σ qty × (vendor_price − dealer_price) — what the locks say we EARNED. */
    expected_margin: number;
    /** Σ qty × margin_value — what we set out to earn. */
    planned_margin: number;
    /** What the vendor negotiation was worth. */
    uplift: number;
    difference: number;
    reconciled: boolean;
  };
}

export default function BuybackLedgerPage() {
  const [d, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const qs = direction ? `?direction=${direction}` : "";
      const res = await fetch(`/api/admin/buyback/ledger${qs}`);
      const json = await res.json();
      if (cancelled) return;
      setData(json?.data ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [direction]);

  const r = d?.reconciliation;

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Transaction history</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Every settlement, both directions. Payments are recorded here, never executed.
          </p>
        </div>
        <a
          href="/api/admin/buyback/ledger?format=csv"
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Export CSV
        </a>
      </div>

      {/* THE RECONCILIATION INVARIANT. Shown pass or fail. */}
      {r && (
        <div
          className={`mt-5 rounded-xl border px-4 py-3 ${
            r.reconciled
              ? "border-emerald-200 bg-emerald-50"
              : "border-red-300 bg-red-50"
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              <div
                className={`text-xs font-bold uppercase tracking-wide ${
                  r.reconciled ? "text-emerald-700" : "text-red-700"
                }`}
              >
                {r.reconciled ? "Reconciled" : "DOES NOT RECONCILE"}
              </div>
              <p
                className={`mt-0.5 text-sm ${
                  r.reconciled ? "text-emerald-800" : "text-red-800"
                }`}
              >
                {r.reconciled ? (
                  <>
                    Money that actually moved on closed deals nets to{" "}
                    <b>{inr(r.ledger_net)}</b> — exactly what the locked prices say we
                    earned.
                    {r.uplift > 0 && (
                      <>
                        {" "}
                        <span className="text-emerald-700">
                          {inr(r.uplift)} of that is above the margin we planned — the value
                          of haggling vendors up from our ask.
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    The ledger nets to <b>{inr(r.ledger_net)}</b> but the locked prices say
                    the margin should be <b>{inr(r.expected_margin)}</b>, a difference of{" "}
                    <b>{inr(Math.abs(r.difference))}</b>. A report is reporting a margin
                    that was never earned. Investigate before trusting any dashboard.
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="mt-5 flex gap-2">
        {[
          ["", "All"],
          ["IN", "Money in"],
          ["OUT", "Money out"],
        ].map(([v, label]) => (
          <button
            key={label}
            onClick={() => setDirection(v)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              direction === v
                ? "bg-slate-900 text-white"
                : "border border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {d && (
        <div className="mt-4 grid grid-cols-3 gap-3">
          {[
            ["In", d.totals.in, "text-emerald-700"],
            ["Out", d.totals.out, "text-red-600"],
            ["Net", d.totals.net, "text-slate-900"],
          ].map(([label, value, tone]) => (
            <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                {label as string}
              </div>
              <div className={`mt-1 text-xl font-extrabold tabular-nums ${tone as string}`}>
                {inr(value as number)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-400">Loading…</div>
        ) : !d || d.rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            No settlements recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  {["TXN", "Request", "Counterparty", "Dir", "Method", "Reference", "Proof", "Date", "Amount"].map(
                    (h, i) => (
                      <th key={h} className={`px-4 py-2.5 ${i === 8 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((row) => (
                  <tr key={row.txn} className="border-t border-slate-50">
                    <td className="px-4 py-2.5 font-bold text-slate-800">{row.txn}</td>
                    <td className="px-4 py-2.5 font-semibold text-blue-600">{row.request_no}</td>
                    <td className="px-4 py-2.5 text-slate-600">{row.counterparty}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`font-bold ${
                          row.direction === "IN" ? "text-emerald-700" : "text-red-600"
                        }`}
                      >
                        {row.direction}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">{row.method}</td>
                    <td className="px-4 py-2.5 text-slate-500">{row.txn_ref ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-500">
                      {row.proof_s3 ? "Attached" : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">{row.txn_date}</td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums">
                      {inr(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
