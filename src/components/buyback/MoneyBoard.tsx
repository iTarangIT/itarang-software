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

/** One redacted online-payment attempt, as the invoice GET's gateway.txns entry. */
interface GatewayTxn {
  id: string;
  leg: "DEALER" | "VENDOR";
  kind: "PAYOUT" | "PAYMENT_LINK";
  status: string;
  short_url: string | null;
  utr: string | null;
  failure_reason: string | null;
  created_at: string;
}

/** The masked dealer payout bank — the full account number never reaches here. */
interface DealerBank {
  ok: boolean;
  bank_name: string | null;
  account_masked: string | null;
  ifsc_code: string | null;
  beneficiary: string | null;
}

interface Gateway {
  payouts_enabled: boolean;
  links_enabled: boolean;
  dealer_amount: number | null;
  vendor_amount: number | null;
  dealer_bank: DealerBank;
  txns: GatewayTxn[];
}

interface Money {
  request_id: string;
  status: string;
  invoice: Invoice | null;
  match: Match | null;
  history: Array<{ number: string; returned_reason: string | null }>;
  vendor_invoice: Invoice | null;
  gateway: Gateway | null;
}

interface Settlement {
  leg: "DEALER" | "VENDOR";
  leg_sub_id: string;
  direction: "OUT" | "IN";
  method: "MANUAL" | "STATEMENT" | "API";
  amount: string;
  txn_ref: string | null;
  txn_date: string;
  proof_s3: string | null;
}

// A gateway attempt is "in flight" while it is one of these; PROCESSED/PAID are
// terminal success (a settlement now exists), the rest are terminal failure. The
// server enforces the real guards — these classify the row for the UI only.
const GATEWAY_INFLIGHT = new Set(["INITIATED", "PENDING", "QUEUED", "PROCESSING"]);
const GATEWAY_TERMINAL_FAILURE = new Set(["FAILED", "REJECTED", "CANCELLED", "EXPIRED"]);

// Client-side mirrors of the server's bank-details validation, so the admin sees
// the error before the round-trip. The account number is NEVER logged or echoed.
const ACCOUNT_RE = /^\d{6,20}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

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

  // The RazorpayX payout confirmation. `bankFormOpen` toggles the inline
  // bank-details sub-view inside the same modal (forced open when the bank is
  // incomplete, optional otherwise).
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [bankFormOpen, setBankFormOpen] = useState(false);
  const [bankName, setBankName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankIfsc, setBankIfsc] = useState("");
  const [bankBeneficiary, setBankBeneficiary] = useState("");
  const [bankError, setBankError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const can = (a: string) => allowedActions.includes(a);

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard unavailable — no-op, the link is still visible on the chip */
    }
  };

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

  // Open the RazorpayX payout modal. Start on the bank-details form when the
  // dealer's bank is incomplete; otherwise start on the confirm view. Existing
  // name/IFSC prefill the form; the account number is never prefilled (we only
  // ever hold the masked view) and must be re-entered to change it.
  const openPayout = () => {
    setError(null);
    setBankError(null);
    const bank = m?.gateway?.dealer_bank;
    setBankName(bank?.bank_name ?? "");
    setBankIfsc(bank?.ifsc_code ?? "");
    setBankBeneficiary(bank?.beneficiary ?? "");
    setBankAccount("");
    setBankFormOpen(!bank?.ok);
    setPayoutOpen(true);
  };

  // PATCH the dealer's payout bank, then fold the fresh MASKED view back into
  // state and return to the confirm step. The full account number is dropped
  // from state the moment it is saved — it never renders and never re-renders.
  const saveBank = async () => {
    setBusy(true);
    setBankError(null);
    const res = await fetch(`/api/admin/buyback/requests/${requestId}/bank-details`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank_name: bankName.trim() || undefined,
        bank_account_number: bankAccount.trim(),
        ifsc_code: bankIfsc.trim().toUpperCase(),
        bank_beneficiary_name: bankBeneficiary.trim() || undefined,
      }),
    });
    const json = await res.json();
    setBusy(false);
    if (!json?.success) {
      setBankError(json?.error?.message ?? "Could not save the bank details.");
      return;
    }
    const freshBank: DealerBank | null = json?.data?.dealer_bank ?? null;
    setMoney((prev) =>
      prev && prev.gateway && freshBank
        ? { ...prev, gateway: { ...prev.gateway, dealer_bank: freshBank } }
        : prev,
    );
    setBankAccount("");
    setBankFormOpen(false);
  };

  const bankValid = ACCOUNT_RE.test(bankAccount.trim()) && IFSC_RE.test(bankIfsc.trim().toUpperCase());

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
            Two legs. Pay the dealer online via <b>RazorpayX</b> and collect the vendor by{" "}
            <b>payment link</b> where those are switched on — or settle out of band and record it
            here with proof. The amount is always derived from the locked prices.
          </p>

          <div className="mt-3 space-y-2">
            {(["DEALER", "VENDOR"] as const).map((leg) => {
              const done = settlements.find((s) => s.leg === leg);
              const label =
                leg === "DEALER" ? "Payout to dealer (OUT)" : "Receipt from vendor (IN)";
              const gw = m?.gateway ?? null;

              // The leg's latest attempt (txns are newest-first). Only the latest
              // can be in flight — the DB allows one live attempt per leg.
              const legTxns = (gw?.txns ?? []).filter((t) => t.leg === leg);
              const latest = legTxns[0] ?? null;
              const inflight = latest && GATEWAY_INFLIGHT.has(latest.status) ? latest : null;
              const reversed = latest?.status === "REVERSED" ? latest : null;
              const failed =
                latest && GATEWAY_TERMINAL_FAILURE.has(latest.status) ? latest : null;

              // Initiate/retry buttons: dark unless the provider is configured,
              // hidden once the leg is settled or an attempt is already in flight.
              const showPayout =
                leg === "DEALER" &&
                !!gw?.payouts_enabled &&
                !done &&
                !inflight &&
                can("record_settlement");
              const showLink =
                leg === "VENDOR" &&
                !!gw?.links_enabled &&
                !done &&
                !inflight &&
                can("record_settlement");
              const showManual = !done && can("record_settlement");
              const showActionRow =
                (!done || !!reversed) &&
                Boolean(inflight || reversed || (failed && !done) || showPayout || showLink || showManual);

              return (
                <div key={leg} className="rounded-lg border border-slate-100 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-slate-800">{label}</div>
                      <div className="text-[11px] text-slate-400">
                        {done
                          ? `${done.leg_sub_id} · ${inr(done.amount)} · ${done.txn_ref ?? "—"}`
                          : "Not recorded"}
                      </div>
                    </div>
                    {done && (
                      <div className="flex items-center gap-1.5">
                        {done.method === "API" && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                            via Razorpay
                          </span>
                        )}
                        <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
                          Paid
                        </span>
                      </div>
                    )}
                  </div>

                  {showActionRow && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {/* In-flight: amber status + refresh; a live link is also
                          copyable and cancellable. */}
                      {inflight && (
                        <>
                          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold text-amber-700">
                            {inflight.kind === "PAYMENT_LINK" ? "Link" : "Payout"}{" "}
                            {inflight.status.toLowerCase()}
                          </span>
                          {can("record_settlement") && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                post(
                                  `/api/admin/buyback/requests/${requestId}/settlements/gateway/${inflight.id}/refresh`,
                                )
                              }
                              className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                            >
                              Refresh
                            </button>
                          )}
                          {inflight.kind === "PAYMENT_LINK" && inflight.short_url && (
                            <button
                              onClick={() => copy(inflight.short_url as string, inflight.id)}
                              className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                            >
                              {copied === inflight.id ? "Copied ✓" : "Copy link"}
                            </button>
                          )}
                          {inflight.kind === "PAYMENT_LINK" && can("record_settlement") && (
                            <button
                              disabled={busy}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    "Cancel this payment link? The vendor will no longer be able to pay through it.",
                                  )
                                ) {
                                  post(
                                    `/api/admin/buyback/requests/${requestId}/settlements/payment-link/cancel`,
                                  );
                                }
                              }}
                              className="rounded-lg border border-red-200 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                            >
                              Cancel link
                            </button>
                          )}
                        </>
                      )}

                      {/* A bank reversal on an already-recorded payout — no action,
                          but it must be seen and reconciled by hand. */}
                      {reversed && (
                        <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-bold text-red-700">
                          Reversed by bank — needs manual review
                        </span>
                      )}

                      {/* Terminal failure: the reason (truncated, full on hover);
                          the initiate button below doubles as Retry. */}
                      {failed && !done && (
                        <span
                          title={failed.failure_reason ?? undefined}
                          className="max-w-[240px] truncate rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-bold text-red-700"
                        >
                          {failed.kind === "PAYMENT_LINK" ? "Link failed" : "Payout failed"}
                          {failed.failure_reason ? ` — ${failed.failure_reason}` : ""}
                        </span>
                      )}

                      {showPayout && (
                        <button
                          disabled={busy}
                          onClick={openPayout}
                          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {failed ? "Retry — Pay via RazorpayX" : "Pay via RazorpayX"}
                        </button>
                      )}
                      {showLink && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            post(
                              `/api/admin/buyback/requests/${requestId}/settlements/payment-link`,
                            )
                          }
                          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {failed ? "Retry — Generate payment link" : "Generate payment link"}
                        </button>
                      )}

                      {/* Manual fallback — disabled while an online attempt is live
                          (the server enforces the real guard; this is UX only). */}
                      {showManual && (
                        <button
                          onClick={() => setSettleLeg(leg)}
                          disabled={!!inflight}
                          title={
                            inflight
                              ? "An online payment is in flight for this leg."
                              : undefined
                          }
                          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                        >
                          Record manually
                        </button>
                      )}
                    </div>
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

      {/* ------------------------------------------- RAZORPAYX PAYOUT MODAL */}
      {payoutOpen && m?.gateway && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-sm font-bold text-slate-900">Pay the dealer via RazorpayX</div>

            {bankFormOpen ? (
              /* Bank-details sub-view — forced open when the bank is incomplete,
                 optional ("Edit bank details") otherwise. Fixing bank data is
                 always allowed, even when payouts are switched off. */
              <>
                {!m.gateway.dealer_bank.ok && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    The dealer&apos;s payout bank details are incomplete. Add them before paying
                    out.
                  </div>
                )}

                <div className="mt-4 space-y-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-slate-600">Bank name</span>
                    <input
                      value={bankName}
                      onChange={(e) => setBankName(e.target.value)}
                      placeholder="e.g. HDFC Bank"
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold text-slate-600">Account number</span>
                    <input
                      value={bankAccount}
                      onChange={(e) => setBankAccount(e.target.value.replace(/\s/g, ""))}
                      inputMode="numeric"
                      autoComplete="off"
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    />
                    <span className="mt-1 block text-[11px] text-slate-400">
                      6–20 digits. Stored masked — only the last four are ever shown back.
                    </span>
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold text-slate-600">IFSC code</span>
                    <input
                      value={bankIfsc}
                      onChange={(e) => setBankIfsc(e.target.value.toUpperCase())}
                      placeholder="ABCD0123456"
                      autoComplete="off"
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm uppercase"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold text-slate-600">
                      Beneficiary name <span className="font-normal text-slate-400">(optional)</span>
                    </span>
                    <input
                      value={bankBeneficiary}
                      onChange={(e) => setBankBeneficiary(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    />
                  </label>
                </div>

                {bankError && <div className="mt-3 text-xs text-red-600">{bankError}</div>}

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={() => {
                      // Cancelling the form: back to confirm if the bank is already
                      // usable, otherwise close the whole modal (nothing to confirm).
                      if (m.gateway?.dealer_bank.ok) {
                        setBankFormOpen(false);
                        setBankError(null);
                      } else {
                        setPayoutOpen(false);
                      }
                    }}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={busy || !bankValid}
                    onClick={saveBank}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {busy ? "Saving…" : "Save bank details"}
                  </button>
                </div>
              </>
            ) : (
              /* Confirm view — the amount is derived server-side; the admin
                 confirms it, they do not name it. */
              <>
                <p className="mt-1 text-xs text-slate-500">
                  The amount is taken from the locked prices — you confirm the payout, you do not
                  state its size.
                </p>

                <div className="mt-4 space-y-1.5 rounded-lg bg-slate-50 px-3 py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Amount</span>
                    <span className="tabular-nums font-bold text-slate-900">
                      {inr(m.gateway.dealer_amount)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Beneficiary</span>
                    <span className="font-medium text-slate-700">
                      {m.gateway.dealer_bank.beneficiary ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Account</span>
                    <span className="tabular-nums font-medium text-slate-700">
                      {m.gateway.dealer_bank.account_masked ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">IFSC</span>
                    <span className="font-medium text-slate-700">
                      {m.gateway.dealer_bank.ifsc_code ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Bank</span>
                    <span className="font-medium text-slate-700">
                      {m.gateway.dealer_bank.bank_name ?? "—"}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => {
                    setBankError(null);
                    setBankAccount("");
                    setBankFormOpen(true);
                  }}
                  className="mt-2 text-[11px] font-semibold text-indigo-600 hover:underline"
                >
                  Edit bank details
                </button>

                {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setPayoutOpen(false);
                      setError(null);
                    }}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      post(`/api/admin/buyback/requests/${requestId}/settlements/payout`)
                    }
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {busy ? "Paying…" : `Pay ${inr(m.gateway.dealer_amount)}`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
