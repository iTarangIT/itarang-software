"use client";

/**
 * E-234 — the live-auction strip on the dealer home (Battery Auction BRD §17).
 *
 * The BRD asks for a dashboard carousel of live lots alongside the bell, email,
 * WhatsApp and SMS notice. This is that surface: the one place a dealer who
 * never opened the notification still sees that a lot is running.
 *
 * IT READS THE SAME AUDIENCE-SCOPED ENDPOINT AS THE BROWSE PAGE.
 * `/api/dealer/auctions` already filters by the frozen audience, so a lot this
 * dealer was never in the audience for cannot appear here — the scoping is not
 * re-implemented, which is exactly how it should stay.
 *
 * RENDERS NOTHING WHEN THERE IS NOTHING. No empty state, no "no live auctions"
 * card. A dealer who is not in any audience should not have a permanent hole on
 * their dashboard advertising a feature that is not for them today.
 *
 * A scroll-snap rail, not a timed carousel: auto-advance moves the thing the
 * user is reading, and a dealer comparing two lots is reading.
 */
import { useEffect, useState } from "react";
import Link from "next/link";

import {
  CountdownRing,
  ConditionChip,
  formatINR,
} from "@/components/auction/AuctionPrimitives";

/** A subset of `DealerLotCard` (src/lib/nbfc/auction/dealerView.ts). */
type Lot = {
  lot_id: string;
  lot_code: string;
  title: string | null;
  quantity: number;
  base_price: number;
  current_bid: number;
  bid_count: number;
  ends_at: string;
  starts_at: string | null;
  status: string;
  conditions: string[];
  city: string | null;
  distance_km: number | null;
  you_are_leading: boolean;
};

/** Matches the browse grid's cadence so the two never disagree on screen. */
const POLL_MS = 5_000;

export default function LiveAuctionsStrip() {
  const [lots, setLots] = useState<Lot[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // No `pageSize` here: /api/dealer/auctions does not accept one (its
        // zod schema strips unknown keys silently), so asking for 8 and being
        // given 24 would read like a bug in the API rather than a param that
        // was never supported. The rail takes what it needs below.
        const res = await fetch("/api/dealer/auctions?status=live", {
          cache: "no-store",
        });
        if (!res.ok) {
          // A dealer with no auction access gets 403 here. That is not an
          // error worth showing on a dashboard — the strip simply does not
          // exist for them.
          if (!cancelled) {
            setLots([]);
            setReady(true);
          }
          return;
        }
        const json = await res.json();
        if (cancelled) return;
        // A dashboard rail, not the browse page: eight is as many as anyone
        // scrolls sideways before clicking through.
        setLots((json?.data?.items ?? json?.items ?? []).slice(0, 8));
        setReady(true);
      } catch {
        if (!cancelled) setReady(true);
      }
    }

    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!ready || lots.length === 0) return null;

  return (
    <section className="auction-sheet">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="auc-eyebrow" style={{ marginBlockEnd: "0.5rem" }}>
            Live battery auctions
          </p>
          <p className="auc-lede" style={{ marginBlockStart: 0 }}>
            {lots.length} lot{lots.length === 1 ? "" : "s"} open to you right now.
          </p>
        </div>
        <Link href="/dealer-portal/auctions" className="auc-btn" data-variant="ghost">
          Browse all
        </Link>
      </div>

      <ul
        className="auc-scroll-x"
        style={{
          display: "grid",
          gridAutoFlow: "column",
          gridAutoColumns: "minmax(16rem, 20rem)",
          gap: "1rem",
          marginBlockStart: "1rem",
          paddingBlockEnd: "0.5rem",
          scrollSnapType: "x mandatory",
          listStyle: "none",
        }}
      >
        {lots.map((lot) => {
          const windowMs =
            lot.starts_at != null
              ? new Date(lot.ends_at).getTime() - new Date(lot.starts_at).getTime()
              : undefined;
          return (
            <li key={lot.lot_id} style={{ scrollSnapAlign: "start" }}>
              <Link
                href={`/dealer-portal/auctions/${lot.lot_id}`}
                className="auc-card"
                style={{ display: "block", blockSize: "100%" }}
              >
                <div className="auc-card-head">
                  <span className="auc-lotcode">{lot.lot_code}</span>
                  <CountdownRing endsAt={lot.ends_at} windowMs={windowMs} />
                </div>
                <div style={{ padding: "0 1rem 1rem" }}>
                  <p className="auc-title">
                    {lot.title || `${lot.quantity} × recovered battery`}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.25rem",
                      marginBlock: "0.5rem",
                    }}
                  >
                    {(lot.conditions ?? []).slice(0, 3).map((c) => (
                      <ConditionChip key={c} condition={c} />
                    ))}
                  </div>
                  <div className="auc-price-row">
                    <span className="auc-price-label">
                      {lot.you_are_leading
                        ? "You lead"
                        : lot.current_bid > 0
                          ? "Highest"
                          : "Opening"}
                    </span>
                    <span className="auc-price">
                      {formatINR(lot.current_bid > 0 ? lot.current_bid : lot.base_price)}
                    </span>
                  </div>
                  <p className="auc-meta">
                    {lot.bid_count} bid{lot.bid_count === 1 ? "" : "s"}
                    {lot.city ? ` · ${lot.city}` : ""}
                    {lot.distance_km != null
                      ? ` · ${Math.round(lot.distance_km)} km`
                      : ""}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
