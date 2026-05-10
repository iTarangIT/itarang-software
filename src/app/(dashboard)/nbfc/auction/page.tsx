/**
 * E-038 — Auction marketplace page (BRD §6.1.7)
 *
 * Lists live auction lots and lets the operator place binding bids. Lots are
 * fetched on the client to keep the countdown timer + bid placement flow
 * fully reactive without server round-trips on every tick.
 */
"use client";

import { useEffect, useState } from "react";
import {
  AuctionLotsGrid,
  type AuctionLot,
} from "@/components/nbfc-portal/AuctionLotsGrid";

export default function AuctionPage() {
  const [lots, setLots] = useState<AuctionLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"live" | "ended">("live");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/nbfc/auction/lots?status=${status}`);
        const body = await res.json();
        if (!res.ok) {
          if (!cancelled) setError(body?.error ?? `HTTP ${res.status}`);
          return;
        }
        if (!cancelled) setLots(body.items ?? []);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [status]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Auction Marketplace</h1>
        <div className="flex gap-1 text-sm">
          {(["live", "ended"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-md border ${
                status === s
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white dark:bg-slate-900"
              }`}
            >
              {s === "live" ? "Live" : "Ended"}
            </button>
          ))}
        </div>
      </div>
      {loading && <p className="text-sm text-slate-500">Loading lots…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && <AuctionLotsGrid lots={lots} />}
    </div>
  );
}
