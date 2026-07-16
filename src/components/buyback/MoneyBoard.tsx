"use client";

/**
 * The money board (M12/M13) — invoice approval, settlement, close.
 *
 * Self-contained, like the vendor board.
 *
 * THE SCREEN THE M12 AC LIVES ON. When a dealer shifts price between lines so the
 * TOTAL comes out right, this shows both totals side by side, agreeing — and then
 * shows the per-line verdicts that disagree, and disables Approve. An admin who
 * sees two matching totals and a blocked button needs to be told why in the same
 * glance, or they will assume the software is broken and go looking for an
 * override.
 *
 * The design prototype approves without comparing anything and toasts "Matched
 * locked price ✓". This shows the comparison it claims to have made.
 */

import { useCallback, useEffect, useState } from "react";

import { EvidenceUpload } from "./ui";
import { inr } from "@/lib/buyback/format";

interface Verdict {
  line_id: string;
  label: string;
  matched: boolean;
  code?: string;
  billed_price?: number;
  locked_price?: number;
  billed_quantity?: number;
  locked_quantity?: number;
  reason?: string;
}

interface Match {
  ok: boolean;
  verdicts: Verdict[];
  billed_total: number;
  locked_total: number;
  summary: string | null;
}

interface Invoice {
  id: string;
  number: string;
  status: string;
  leg: string;
}

interface Money {
  request_id: string;
  status: string;
  invoice: Invoice | null;
  match: Match | null;
  history: Array<{ number: string; returned_reason: string | null }>;
  vendor_invoice: Invoice | null;
}

interface Settlement {
  leg: "DEALER" | "VENDOR";
  leg_sub_id: string;
  direction: "OUT" | "IN";
  amount: string;
  txn_ref: string | null;
  txn_date: string;
  proof_s3: string | null;
}

export default function MoneyBoard({
  requestId,
  status,
  allowedActions,
}: {
  requestId: string;
  status: string;
  allowedActions: string[];
}) {
  const [m, setMoney] = useState<Money | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [settleLeg, setSettleLeg] = useState<"DEALER" | "VENDOR" | null>(null);
  const [txnRef, setTxnRef] = useState("");
  const [txnDate, setTxnDate] = useState(new Date().toISOString().slice(0, 10));
  const [proof, setProof] = useState<{ key: string; name: string } | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const can = (a: string) => allowedActions.includes(a);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/admin/buyback/requests/${requestId}/invoice`);
      const json = await res.json();
      if (cancelled) return;
      setMoney(json?.data ?? null);
      setSettlements(json?.data?.settlements ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, reloadKey]);

  const post = async (url: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    setBusy(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "Action failed.");
      return false;
    }
    setSettleLeg(null);
    setReason("");
    setTxnRef("");
    setProof(null);
    reload();
    // The parent page owns `status`; a hard reload keeps the two in step without
    // threading a callback through.
    window.location.reload();
    return true;
  };

  // Nothing to show before the batteries are collected.
  if (!["PICKED_UP", "INVOICE_RAISED", "INVOICE_APPROVED", "SETTLED", "CLOSED"].includes(status)) {
    return null;
  }

  const match = m?.match ?? null;
  const totalsAgree = match && match.billed_total === match.locked_total;

  return (
    <div className="mt-6 space-y-4">
      <h2 className="text-sm font-bold text-slate-900">Money</h2>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {status === "PICKED_UP" && (
        <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
          Collected. Waiting for the dealer to raise their invoice.
          {m && m.history.length > 0 && (
            <div className="mt-1 text-xs text-amber-600">
              Last invoice was returned: {m.history[0].returned_reason}
            </div>
          )}
        </div>
      )}

      {/* --------------------------------------------------- INVOICE APPROVAL */}
      {m?.invoice && match && status === "INVOICE_RAISED" && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">
              Invoice {m.invoice.number}
            </div>
            <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-700">
              Awaiting approval
            </span>
          </div>

          {/* Both totals, always — so the "they agree but it's still wrong" case
              is legible rather than baffling. */}
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-[10px] font-bold uppercase text-slate-400">Billed</div>
              <div className="tabular-nums font-bold">{inr(match.billed_total)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-[10px] font-bold uppercase text-slate-400">Agreed</div>
              <div className="tabular-nums font-bold">{inr(match.locked_total)}</div>
            </div>
          </div>

          {!match.ok && totalsAgree && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
              <b>The totals agree — but the individual battery prices do not.</b> Approving
              on the total alone would pay the wrong amount per variant, and every report
              downstream reads the per-variant numbers. This cannot be approved.
            </div>
          )}

          <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
            {match.verdicts.map((v, i) => (
              <div
                key={v.line_id}
                className={`flex items-center justify-between px-3 py-2 text-sm ${
                  i ? "border-t border-slate-100" : ""
                } ${v.matched ? "" : "bg-red-50"}`}
              >
                <div>
                  <span className="font-medium text-slate-700">{v.label}</span>
                  {!v.matched && (
                    <div className="text-[11px] text-red-600">{v.reason}</div>
                  )}
                </div>
                <span
                  className={`text-xs font-bold ${
                    v.matched ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {v.matched ? "✓ matches" : "✕ mismatch"}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-2">
            <button
              disabled={busy || !match.ok || !can("approve_invoice")}
              title={
                match.ok
                  ? undefined
                  : "Blocked: at least one line does not match the price the dealer accepted."
              }
              onClick={() =>
                post(`/api/admin/buyback/requests/${requestId}/invoice`, { action: "approve" })
              }
              className="flex-1 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              Approve &amp; invoice the vendor
            </button>
            <button
              disabled={busy}
              onClick={() =>
                post(`/api/admin/buyback/requests/${requestId}/invoice`, {
                  action: "return",
                  reason: reason.trim() || undefined,
                })
              }
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
            >
              Return
            </button>
          </div>

          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={match.summary ?? "Reason for returning (optional — we'll use the mismatch)"}
            className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
          />
        </div>
      )}

      {/* -------------------------------------------------------- SETTLEMENT */}
      {["INVOICE_APPROVED", "SETTLED", "CLOSED"].includes(status) && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-900">Settlement</div>
          <p className="mt-1 text-xs text-slate-500">
            Two legs. Payments are <b>recorded here, not executed</b> — pay out of band, then
            record it with proof.
          </p>

          <div className="mt-3 space-y-2">
            {(["DEALER", "VENDOR"] as const).map((leg) => {
              const done = settlements.find((s) => s.leg === leg);
              const label =
                leg === "DEALER" ? "Payout to dealer (OUT)" : "Receipt from vendor (IN)";

              return (
                <div
                  key={leg}
                  className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2"
                >
                  <div>
                    <div className="text-xs font-semibold text-slate-800">{label}</div>
                    <div className="text-[11px] text-slate-400">
                      {done
                        ? `${done.leg_sub_id} · ${inr(done.amount)} · ${done.txn_ref ?? "—"}`
                        : "Not recorded"}
                    </div>
                  </div>

                  {!done && can("record_settlement") && (
                    <button
                      onClick={() => setSettleLeg(leg)}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      Record
                    </button>
                  )}
                  {done && (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
                      Paid
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {can("close_deal") && (
            <button
              disabled={busy}
              onClick={() => post(`/api/admin/buyback/requests/${requestId}/close`)}
              className="mt-3 w-full rounded-lg bg-slate-900 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Close deal
            </button>
          )}

          {status === "CLOSED" &&
            (() => {
              // The figure the guide's close step promises: what iTarang
              // actually made — vendor receipt minus dealer payout.
              const paidOut = settlements.find((s) => s.leg === "DEALER");
              const paidIn = settlements.find((s) => s.leg === "VENDOR");
              const profit =
                paidOut && paidIn ? Number(paidIn.amount) - Number(paidOut.amount) : null;
              return (
                <p className="mt-3 text-xs text-emerald-700">
                  Closed and reconciled — the money that moved matches the locked margin.
                  {profit !== null && (
                    <b className="ml-1">Realised profit: {inr(profit)}.</b>
                  )}
                </p>
              );
            })()}
        </div>
      )}

      {/* ------------------------------------------------- SETTLEMENT MODAL */}
      {settleLeg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-sm font-bold text-slate-900">
              Record {settleLeg === "DEALER" ? "payout to dealer" : "receipt from vendor"}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              The amount is taken from the locked prices — you evidence the payment, you do
              not state its size.
            </p>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-xs font-semibold text-slate-600">
                  Bank reference / UTR
                </span>
                <input
                  value={txnRef}
                  onChange={(e) => setTxnRef(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>

              <label className="block">
                <span className="text-xs font-semibold text-slate-600">Payment date</span>
                <input
                  type="date"
                  value={txnDate}
                  onChange={(e) => setTxnDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>

              <label className="block">
                <span className="text-xs font-semibold text-slate-600">Proof of payment</span>
                <div className="mt-1">
                  <EvidenceUpload
                    endpoint="/api/admin/buyback/uploads"
                    kind="settlement_proof"
                    requestId={requestId}
                    label="proof of payment"
                    value={proof}
                    onChange={setProof}
                    disabled={busy}
                  />
                </div>
                <span className="mt-1 block text-[11px] text-slate-400">
                  Required. A payment with no evidence is not a payment — the database
                  refuses it.
                </span>
              </label>
            </div>

            {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setSettleLeg(null);
                  setError(null);
                }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                disabled={busy || !txnRef.trim() || !proof}
                onClick={() =>
                  post(`/api/admin/buyback/requests/${requestId}/settlements`, {
                    leg: settleLeg,
                    method: "MANUAL",
                    txn_ref: txnRef.trim(),
                    txn_date: txnDate,
                    proof_s3: proof?.key,
                  })
                }
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {busy ? "Recording…" : "Record payment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
