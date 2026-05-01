"use client";

/**
 * E-038 — PlaceBidModal (BRD §6.1.7)
 *
 * Bidding modal: surfaces the current highest bid and the bidder's last bid
 * status, runs a live HH:MM:SS countdown, validates min-next-bid client-side
 * (server is authoritative), and requires the user to confirm "₹X — this is
 * binding" before posting.
 */
import { useEffect, useMemo, useState } from "react";
import type { AuctionLot } from "./AuctionLotsGrid";

interface PlaceBidModalProps {
  lot: AuctionLot;
  onClose: () => void;
}

function fmtINR(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

export function PlaceBidModal({ lot, onClose }: PlaceBidModalProps) {
  const minNext = lot.current_bid + (lot.bid_increment ?? 0);
  const [amount, setAmount] = useState<string>(String(minNext || lot.base_price));
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "accepted"; bid_id: string; amount: number }
    | { kind: "rejected"; reason: string }
    | { kind: "error"; message: string }
    | null
  >(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = useMemo(() => {
    const end = new Date(lot.ends_at).getTime();
    const diff = Math.max(0, end - now);
    const total = Math.floor(diff / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
      s,
    ).padStart(2, "0")}`;
  }, [lot.ends_at, now]);

  const numericAmount = Number(amount);
  const meetsMin =
    Number.isFinite(numericAmount) && numericAmount >= minNext && numericAmount > 0;

  async function submit() {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch(`/api/nbfc/auction/lots/${lot.lot_id}/bid`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: numericAmount, confirmed: true }),
      });
      const body = await res.json();
      if (!res.ok) {
        setResult({ kind: "error", message: body?.error ?? `HTTP ${res.status}` });
      } else if (body?.accepted) {
        setResult({
          kind: "accepted",
          bid_id: body.bid_id,
          amount: body.amount,
        });
      } else {
        setResult({
          kind: "rejected",
          reason: body?.rejection_reason ?? "rejected",
        });
      }
    } catch (e) {
      setResult({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg max-w-md w-full p-6 space-y-4">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold">
            Place bid — {lot.lot_code ?? lot.lot_id.slice(0, 8)}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <div className="text-slate-500 text-xs">Current highest bid</div>
            <div className="font-semibold">{fmtINR(lot.current_bid)}</div>
          </div>
          <div>
            <div className="text-slate-500 text-xs">Time remaining</div>
            <div className="font-mono tabular-nums">{remaining}</div>
          </div>
          <div>
            <div className="text-slate-500 text-xs">Min next bid</div>
            <div>{fmtINR(minNext)}</div>
          </div>
          <div>
            <div className="text-slate-500 text-xs">Increment</div>
            <div>{lot.bid_increment != null ? fmtINR(lot.bid_increment) : "—"}</div>
          </div>
        </div>

        <label className="block text-sm">
          Bid amount (INR)
          <input
            type="number"
            min={minNext}
            step={lot.bid_increment ?? 1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={submitting || confirming}
            className="mt-1 w-full border rounded-md px-3 py-2"
          />
        </label>
        {!meetsMin && (
          <p className="text-xs text-amber-600">
            Amount must be at least {fmtINR(minNext)}.
          </p>
        )}

        {result?.kind === "accepted" && (
          <p className="text-sm text-green-700">
            Bid accepted ({fmtINR(result.amount)}). ID {result.bid_id.slice(0, 8)}.
          </p>
        )}
        {result?.kind === "rejected" && (
          <p className="text-sm text-amber-700">
            Bid not accepted: {result.reason}.
          </p>
        )}
        {result?.kind === "error" && (
          <p className="text-sm text-red-700">{result.message}</p>
        )}

        {!confirming ? (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm rounded-md border"
            >
              Exit
            </button>
            <button
              type="button"
              disabled={!meetsMin}
              onClick={() => setConfirming(true)}
              className="px-3 py-2 text-sm rounded-md bg-blue-600 text-white disabled:opacity-50"
            >
              Place Bid
            </button>
          </div>
        ) : (
          <div className="space-y-3 border-t pt-3">
            <p className="text-sm">
              Confirm bid of <strong>{fmtINR(numericAmount)}</strong>? This is
              binding.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={submitting}
                className="px-3 py-2 text-sm rounded-md border"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="px-3 py-2 text-sm rounded-md bg-blue-600 text-white disabled:opacity-50"
              >
                {submitting ? "Submitting…" : "Confirm binding bid"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
