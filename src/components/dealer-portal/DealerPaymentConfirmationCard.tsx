"use client";

/**
 * E-298 — Step 5 card: did the lender's disbursal reach the dealer?
 *
 * Renders only for a sanction the dispatch flow has put into the
 * confirmation loop (`dealer_payment_status` non-null). `received` is final;
 * `not_received` can still be updated (e.g. once the money lands).
 */
import { useState } from "react";
import { AlertCircle, Banknote, CheckCircle2, Loader2, XCircle } from "lucide-react";

export interface DealerPaymentSanction {
  id: string;
  dealer_payment_status?: string | null;
  dealer_payment_confirmed_at?: string | null;
  dealer_payment_utr?: string | null;
  dealer_payment_amount?: string | null;
  dealer_payment_remarks?: string | null;
  loan_amount?: string | null;
  disbursement_amount?: string | null;
}

function fmtINR(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : "—";
}

export default function DealerPaymentConfirmationCard({
  sanction,
  onUpdated,
}: {
  sanction: DealerPaymentSanction;
  onUpdated?: () => void;
}) {
  const [status, setStatus] = useState(sanction.dealer_payment_status ?? null);
  const [utr, setUtr] = useState(sanction.dealer_payment_utr ?? "");
  const [amount, setAmount] = useState(sanction.dealer_payment_amount ?? "");
  const [remarks, setRemarks] = useState(sanction.dealer_payment_remarks ?? "");
  const [busy, setBusy] = useState<null | "ok" | "no">(null);
  const [error, setError] = useState<string | null>(null);

  if (!status) return null;

  const submit = async (received: boolean) => {
    setBusy(received ? "ok" : "no");
    setError(null);
    try {
      const res = await fetch(`/api/dealer/loans/${encodeURIComponent(sanction.id)}/payment-confirmation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          received,
          utr: utr.trim() || null,
          amount: amount.toString().trim() ? Number(amount) : null,
          remarks: remarks.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setError(json?.error?.message || "Could not save your answer");
        if (res.status === 409) setStatus("received");
        return;
      }
      setStatus(json.data?.status ?? (received ? "received" : "not_received"));
      onUpdated?.();
    } catch {
      setError("Could not save your answer");
    } finally {
      setBusy(null);
    }
  };

  if (status === "received") {
    return (
      <section id="payment-confirmation" className="bg-white border-2 border-emerald-200 rounded-2xl p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5" />
          <div className="text-sm">
            <h2 className="font-bold text-emerald-900">Loan payment received</h2>
            <p className="text-xs text-gray-600 mt-1">
              You confirmed the disbursal reached your account
              {utr.trim() ? ` · UTR ${utr.trim()}` : ""}
              {amount.toString().trim() ? ` · ${fmtINR(amount)}` : ""}.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const notReceived = status === "not_received";
  return (
    <section
      id="payment-confirmation"
      className={`bg-white border-2 rounded-2xl p-5 shadow-sm space-y-4 ${
        notReceived ? "border-red-200" : "border-amber-200"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
            notReceived ? "bg-red-100" : "bg-amber-100"
          }`}
        >
          {notReceived ? (
            <XCircle className="w-5 h-5 text-red-600" />
          ) : (
            <Banknote className="w-5 h-5 text-amber-600" />
          )}
        </div>
        <div className="flex-1">
          <h2 className={`font-bold ${notReceived ? "text-red-900" : "text-amber-900"}`}>
            {notReceived ? "You reported the payment as NOT received" : "Payment confirmation pending"}
          </h2>
          <p className="text-xs text-gray-600 mt-1">
            {notReceived
              ? "iTarang and the lender have been alerted. Update this once the money arrives."
              : `The lender has disbursed ${fmtINR(sanction.disbursement_amount ?? sanction.loan_amount)} for this loan. Did it reach your account?`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-gray-600">
          Bank reference / UTR (optional)
          <input
            value={utr}
            onChange={(e) => setUtr(e.target.value)}
            maxLength={64}
            className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
          />
        </label>
        <label className="text-xs text-gray-600">
          Amount received (optional)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
          />
        </label>
        <label className="text-xs text-gray-600 sm:col-span-2">
          Remarks (optional)
          <input
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            maxLength={1000}
            className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
          />
        </label>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={() => submit(true)}
          disabled={busy !== null}
          className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm disabled:opacity-50"
        >
          {busy === "ok" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          Confirm received
        </button>
        <button
          onClick={() => submit(false)}
          disabled={busy !== null}
          className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 border-2 border-red-200 text-red-700 hover:bg-red-50 rounded-xl font-bold text-sm disabled:opacity-50"
        >
          {busy === "no" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
          Not received
        </button>
      </div>
    </section>
  );
}
