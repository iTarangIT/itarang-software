"use client";

/**
 * E-038 — Auction lots grid (BRD §6.1.7)
 *
 * Renders the lot cards for the auction marketplace. Each card surfaces:
 *   Lot ID, capacity, avg SOH, age, quantity, base price, current bid,
 *   bidder count, and a live countdown timer to ends_at.
 */
import { useEffect, useMemo, useState } from "react";
import { PlaceBidModal } from "./PlaceBidModal";

export interface AuctionLot {
  lot_id: string;
  lot_code?: string;
  capacity: string | null;
  avg_soh: number | null;
  age_months: number | null;
  quantity: number;
  base_price: number;
  bid_increment?: number;
  current_bid: number;
  bidder_count: number;
  ends_at: string;
}

interface AuctionLotsGridProps {
  lots: AuctionLot[];
}

function fmtINR(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

function CountdownCell({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = useMemo(() => {
    const end = new Date(endsAt).getTime();
    const diff = Math.max(0, end - now);
    const totalSec = Math.floor(diff / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
      s,
    ).padStart(2, "0")}`;
  }, [endsAt, now]);
  return (
    <span className="font-mono text-sm tabular-nums">{remaining}</span>
  );
}

export function AuctionLotsGrid({ lots }: AuctionLotsGridProps) {
  const [activeLot, setActiveLot] = useState<AuctionLot | null>(null);

  if (lots.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-dashed border-slate-300 rounded-lg p-12 text-center text-sm text-slate-500">
        No live lots at the moment.
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {lots.map((lot) => (
          <div
            key={lot.lot_id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 space-y-2"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs uppercase text-slate-500">Lot</div>
                <div className="font-semibold">
                  {lot.lot_code ?? lot.lot_id.slice(0, 8)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase text-slate-500">Ends in</div>
                <CountdownCell endsAt={lot.ends_at} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-slate-500">Capacity</dt>
                <dd>{lot.capacity ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Avg SOH</dt>
                <dd>{lot.avg_soh != null ? `${lot.avg_soh}%` : "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Age</dt>
                <dd>{lot.age_months != null ? `${lot.age_months} mo` : "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Qty</dt>
                <dd>{lot.quantity}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Base price</dt>
                <dd>{fmtINR(lot.base_price)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Current bid</dt>
                <dd className="font-semibold">{fmtINR(lot.current_bid)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Bidders</dt>
                <dd>{lot.bidder_count}</dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={() => setActiveLot(lot)}
              className="w-full mt-2 px-3 py-2 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
            >
              Place Bid
            </button>
          </div>
        ))}
      </div>
      {activeLot && (
        <PlaceBidModal lot={activeLot} onClose={() => setActiveLot(null)} />
      )}
    </>
  );
}
