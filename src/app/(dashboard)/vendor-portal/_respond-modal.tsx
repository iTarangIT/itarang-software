"use client";

/**
 * The vendor's first-hand answer to one quotation (E-195, BRD M24) — the UI for
 * POST /api/vendor/threads/:id/respond.
 *
 * Three moves, matching the endpoint exactly:
 *   · Submit counter — per-SKU ₹/unit prices → thread COUNTERED
 *   · Accept         — agree at the STANDING price (their counter, or our ask).
 *                      The endpoint ignores any prices on an agree — a vendor may
 *                      not "agree" at a number nobody offered — so the inputs are
 *                      for a counter only, and Accept takes the standing figure.
 *   · Decline        — walk away → thread LOST
 *
 * The floor guard lives server-side: an agree below dealer_price+margin is
 * REFUSED (422). We surface whatever message the API returns rather than
 * pre-judging it here — the vendor never sees the floor itself, only that the
 * price wasn't accepted.
 */

import { useState } from "react";

import { inr } from "@/lib/buyback/format";

import type { VendorThread } from "./_shared";

type Kind = "counter" | "agree" | "decline";
type RespondBody = { kind: Kind; lines?: { line_id: string; price: number }[] };

export function RespondModal({
  thread,
  onClose,
  onDone,
}: {
  thread: VendorThread;
  onClose: () => void;
  onDone: () => void;
}) {
  // Per-line counter inputs, keyed by line_id, seeded from the standing price
  // (their last counter where they made one, else our ask).
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      thread.lines.map((l) => [l.line_id, String(l.counter_price ?? l.ask_price ?? "")]),
    ),
  );
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);

  const counterTotal = thread.lines.reduce((sum, l) => {
    const p = Number(prices[l.line_id]);
    return sum + (Number.isFinite(p) ? p * l.quantity : 0);
  }, 0);

  // What "Accept" agrees to: the standing total the endpoint will use.
  const standingTotal = thread.counter_total ?? thread.ask_total ?? 0;
  const acceptWord = thread.status === "COUNTERED" ? "your counter" : "our ask";

  const submit = async (kind: Kind) => {
    setError(null);
    const payload: RespondBody = { kind };

    if (kind === "counter") {
      const lines = thread.lines.map((l) => ({
        line_id: l.line_id,
        price: Number(prices[l.line_id]),
      }));
      if (lines.some((x) => !Number.isFinite(x.price) || x.price <= 0)) {
        setError("Enter a price per unit greater than zero for every line.");
        return;
      }
      payload.lines = lines;
    }

    setBusy(kind);
    const res = await fetch(`/api/vendor/threads/${thread.thread_id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const json = await res?.json().catch(() => null);
    setBusy(null);

    if (!json?.success) {
      setError(json?.error?.message ?? "Could not submit your response. Try again.");
      return;
    }
    onDone();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-bold text-slate-900">
              Respond to {thread.quotation_no}
            </div>
            <div className="text-[12px] text-slate-500">
              {thread.total_units} units · {thread.lines.length} SKU
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 text-2xl leading-none text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-slate-400">
                <th className="pb-1.5 text-left font-semibold">Battery</th>
                <th className="pb-1.5 text-right font-semibold">Qty</th>
                <th className="pb-1.5 text-right font-semibold">Our ask</th>
                <th className="pb-1.5 text-right font-semibold">Your ₹/unit</th>
              </tr>
            </thead>
            <tbody>
              {thread.lines.map((l) => (
                <tr key={l.line_id} className="border-t border-slate-100">
                  <td className="py-2 text-slate-700">
                    {l.spec_label} · {l.condition}
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-600">{l.quantity}</td>
                  <td className="py-2 text-right tabular-nums text-slate-600">
                    {l.ask_price !== null ? `${inr(Number(l.ask_price))}/u` : "—"}
                  </td>
                  <td className="py-2 text-right">
                    <span className="inline-flex items-center gap-1">
                      <span className="text-slate-400">₹</span>
                      <input
                        inputMode="decimal"
                        value={prices[l.line_id] ?? ""}
                        onChange={(e) =>
                          setPrices((p) => ({ ...p, [l.line_id]: e.target.value }))
                        }
                        className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-right text-[12.5px]"
                      />
                      <span className="text-slate-400">/u</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2 text-right text-[12px] text-slate-500">
          Your counter total:{" "}
          <span className="font-semibold tabular-nums text-slate-800">{inr(counterTotal)}</span>
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void submit("counter")}
            disabled={!!busy}
            className="rounded-lg bg-bb-navy px-4 py-2 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy === "counter" ? "Sending…" : "Submit counter"}
          </button>
          <button
            onClick={() => void submit("agree")}
            disabled={!!busy}
            className="rounded-lg bg-green-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy === "agree" ? "Agreeing…" : `Accept ${inr(standingTotal)}`}
          </button>

          <div className="ml-auto">
            {confirmDecline ? (
              <span className="flex items-center gap-2">
                <span className="text-[12px] text-slate-500">Decline this lot?</span>
                <button
                  onClick={() => void submit("decline")}
                  disabled={!!busy}
                  className="rounded-lg border border-red-300 px-3 py-2 text-[12px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {busy === "decline" ? "…" : "Yes, decline"}
                </button>
                <button
                  onClick={() => setConfirmDecline(false)}
                  className="text-[12px] text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmDecline(true)}
                disabled={!!busy}
                className="rounded-lg border border-slate-200 px-3 py-2 text-[12px] font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
              >
                Decline
              </button>
            )}
          </div>
        </div>

        <p className="mt-3 text-[11px] text-slate-400">
          A counter sends new per-unit prices back to iTarang. Accept agrees at {acceptWord}. You
          only ever see the ask price — never the dealer or iTarang&apos;s margin.
        </p>
      </div>
    </div>
  );
}
