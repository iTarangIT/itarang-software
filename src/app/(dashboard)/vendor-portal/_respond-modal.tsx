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
 *
 * This screen used to be a four-column price table: SKU label, qty, our ask, an
 * input. That asked a scrap buyer to name a number for "62V 33Ah · Dead" and
 * told them nothing else — no photos, no chemistry, no weight — while the
 * quotation PDF sitting in the same vendor's inbox spelled all of it out. So the
 * table is now the battery cards themselves, with the price input on the card it
 * belongs to. Same three actions, same server contract; what changed is that the
 * evidence is on screen at the moment the price is typed.
 */

import { useState } from "react";

import { inr, lineTotal } from "@/lib/buyback/format";

import { BatteryCard, useLightbox } from "./_battery-lines";
import { lotWeight, type VendorThread } from "./_shared";

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
  const lightbox = useLightbox();

  const counterTotal = thread.lines.reduce((sum, l) => {
    const p = Number(prices[l.line_id]);
    return sum + (Number.isFinite(p) ? p * l.quantity : 0);
  }, 0);

  // What "Accept" agrees to: the standing total the endpoint will use.
  const standingTotal = thread.counter_total ?? thread.ask_total ?? 0;
  const acceptWord = thread.status === "COUNTERED" ? "your counter" : "our ask";

  const location = [thread.pickup_city, thread.pickup_state].filter(Boolean).join(", ");
  const weight = lotWeight(thread.lines);

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
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 pb-3.5 pt-5">
          <div>
            <div className="text-[15px] font-bold text-slate-900">
              Respond to {thread.quotation_no}
            </div>
            <div className="mt-0.5 text-[12px] text-slate-500">
              {thread.total_units} units · {thread.lines.length} SKU
              {location ? ` · Pickup ${location}` : ""}
              {weight ? ` · ${weight.kg} kg` : ""}
            </div>
            {/* Say when the weight is partial. A total that quietly covers three of
                five SKUs is worse than no total: it is a number the vendor will
                price against believing it covers the lot. */}
            {weight && weight.declared < weight.of && (
              <div className="mt-0.5 text-[11px] text-amber-700">
                Weight declared for {weight.declared} of {weight.of} SKUs
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 text-2xl leading-none text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        {/* The cards scroll; the totals and the three actions stay put, so a lot
            with six SKUs cannot push Accept off the bottom of the screen. */}
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto bg-bb-bg px-5 py-4">
          {thread.lines.map((l) => {
            const typed = prices[l.line_id];
            const rowTotal = lineTotal(l.quantity, typed);

            return (
              <BatteryCard
                key={l.line_id}
                threadId={thread.thread_id}
                line={l}
                onOpenPhoto={lightbox.open}
              >
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-3">
                  <span className="text-[12.5px] text-slate-500">
                    Our ask{" "}
                    <span className="font-semibold tabular-nums text-slate-800">
                      {l.ask_price !== null ? `${inr(Number(l.ask_price))}/u` : "—"}
                    </span>
                  </span>

                  <label className="ml-auto flex items-center gap-1.5 text-[12.5px] text-slate-500">
                    <span>Your price</span>
                    <span className="text-slate-400">₹</span>
                    <input
                      inputMode="decimal"
                      value={prices[l.line_id] ?? ""}
                      onChange={(e) => setPrices((p) => ({ ...p, [l.line_id]: e.target.value }))}
                      aria-label={`Your price per unit for ${l.spec_label} ${l.condition}`}
                      className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-right text-[12.5px] tabular-nums focus:border-bb-navy focus:outline-none focus:ring-1 focus:ring-bb-navy/30"
                    />
                    <span className="text-slate-400">/u</span>
                  </label>

                  {/* Per-line total. The vendor is typing a per-unit number but
                      settling a per-line one, and doing that multiplication in
                      their head across a mixed lot is where a quote goes wrong. */}
                  <span className="w-full text-right text-[11.5px] text-slate-400 sm:w-auto">
                    {rowTotal === null || rowTotal <= 0 ? (
                      "—"
                    ) : (
                      <>
                        {l.quantity} × {inr(typed)} ={" "}
                        <span className="font-semibold tabular-nums text-slate-700">
                          {inr(rowTotal)}
                        </span>
                      </>
                    )}
                  </span>
                </div>
              </BatteryCard>
            );
          })}
        </div>

        <div className="rounded-b-2xl border-t border-slate-200 px-5 pb-5 pt-3.5">
          <div className="text-right text-[12px] text-slate-500">
            Your counter total:{" "}
            <span className="font-semibold tabular-nums text-slate-800">{inr(counterTotal)}</span>
          </div>

          {error && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
          )}

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
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

      {lightbox.overlay}
    </div>
  );
}
