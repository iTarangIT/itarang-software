"use client";

/**
 * The seller's lot console.
 *
 * WHAT THIS REPLACES
 *   `/nbfc/auction` used to be a MARKETPLACE: a grid of lots with an "Enter
 *   lot" button that opened a bidding modal. That modal posted to
 *   `/api/nbfc/auction/lots/[id]/bid`, which has returned 403 by design since
 *   the E-232 bidder re-point — BRD §9 is "dealers only, never other NBFCs".
 *   So the page's primary action had been a guaranteed error for some time, and
 *   the page itself showed every NBFC's lots to every other NBFC.
 *
 *   An NBFC is a SELLER here, not a bidder. This is their own stock: what is
 *   drafted, what is scheduled, what is running, what has closed.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { nbfcFetch, formatINR } from "@/lib/auction/client";
import {
  CountdownRing,
  StatusChip,
  SohBar,
  Eyebrow,
} from "@/components/auction/AuctionPrimitives";

interface SellerLot {
  lot_id: string;
  lot_code: string;
  title: string | null;
  capacity: string | null;
  avg_soh: number | null;
  quantity: number;
  base_price: number;
  bid_increment: number;
  current_bid: number;
  bidder_count: number;
  starts_at: string | null;
  ends_at: string;
  status: string;
  auction_type: string;
}

const TABS = [
  { key: "live", label: "Live" },
  { key: "scheduled", label: "Scheduled" },
  { key: "draft", label: "Drafts" },
  { key: "paused", label: "Paused" },
  { key: "ended", label: "Ended" },
  { key: "all", label: "All" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function SellerLotsConsole() {
  const [tab, setTab] = useState<TabKey>("live");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "nbfc", "lots", tab],
    queryFn: () =>
      // This route answers with the payload BARE — no `ok` wrapper — which
      // `nbfcFetch` treats as success on a 2xx.
      nbfcFetch<{ items: SellerLot[]; total: number; page: number }>(
        `/api/nbfc/auction/lots?status=${tab}`,
      ),
    refetchInterval: tab === "live" ? 15_000 : false,
    refetchOnWindowFocus: true,
  });

  const lots = data?.items ?? [];

  return (
    <>
      <div className="auc-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            className="auc-tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="auc-grid" style={{ marginBlockStart: "1.25rem" }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="auc-skel-card">
              <div
                className="auc-skel"
                style={{ height: "1rem", width: "45%" }}
              />
              <div
                className="auc-skel"
                style={{ height: "2.25rem", width: "70%" }}
              />
              <div className="auc-skel" style={{ height: "1rem" }} />
              <div
                className="auc-skel"
                style={{ height: "1rem", width: "60%" }}
              />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="auc-inline-error" style={{ marginBlockStart: "1.25rem" }}>
          {(error as Error).message}
        </div>
      ) : lots.length === 0 ? (
        <div className="auc-empty" style={{ marginBlockStart: "1.25rem" }}>
          <p>
            {tab === "live"
              ? "No auctions running"
              : `Nothing ${tab === "all" ? "here" : tab}`}
          </p>
          <p className="auc-empty-hint">
            {tab === "draft"
              ? "Drafts appear here once you start composing. They are private until published."
              : "Compose a lot from batteries that have been inspected and are ready to sell, choose a window and a visibility rule, and publish it."}
          </p>
          <Link href="/nbfc/auction/new" className="auc-btn">
            Compose a lot
          </Link>
        </div>
      ) : (
        <div className="auc-grid" style={{ marginBlockStart: "1.25rem" }}>
          {lots.map((lot) => {
            const hasBids = lot.bidder_count > 0;
            return (
              <article key={lot.lot_id} className="auc-card">
                <div className="auc-card-head" data-status={lot.status}>
                  <div style={{ minInlineSize: 0 }}>
                    <Link
                      href={`/nbfc/auction/${lot.lot_id}`}
                      className="auc-title"
                      style={{ textDecoration: "none", display: "block" }}
                    >
                      {lot.title || lot.lot_code}
                    </Link>
                    <span className="auc-lotcode">{lot.lot_code}</span>
                  </div>
                  {lot.status === "live" ? (
                    <CountdownRing endsAt={lot.ends_at} />
                  ) : (
                    <StatusChip status={lot.status} />
                  )}
                </div>

                <div className="auc-card-body">
                  <div className="auc-price-row">
                    <div>
                      <span className="auc-price-label">
                        {hasBids ? "Current bid" : "Opening price"}
                      </span>
                      <span className="auc-price">
                        {formatINR(hasBids ? lot.current_bid : lot.base_price)}
                      </span>
                    </div>
                    <div>
                      <span className="auc-price-label">Bidders</span>
                      <span className="auc-price">{lot.bidder_count}</span>
                    </div>
                  </div>

                  <div className="auc-meta">
                    <span>
                      <b>{lot.quantity}</b> batter
                      {lot.quantity === 1 ? "y" : "ies"}
                    </span>
                    {lot.capacity ? <span>{lot.capacity}</span> : null}
                    <SohBar soh={lot.avg_soh} />
                  </div>

                  <div className="auc-meta">
                    <span className="auc-subtle">
                      {lot.auction_type === "cash_refinance"
                        ? "cash + refinance"
                        : "cash"}
                    </span>
                    <span className="auc-subtle">
                      +{formatINR(lot.bid_increment)} increment
                    </span>
                  </div>

                  <div
                    className="auc-linkrow"
                    style={{ marginBlockStart: "0.75rem" }}
                  >
                    <Link
                      href={
                        lot.status === "draft"
                          ? `/nbfc/auction/compose/${lot.lot_id}`
                          : `/nbfc/auction/${lot.lot_id}`
                      }
                      className="auc-btn"
                    >
                      {lot.status === "draft" ? "Continue editing" : "Open lot"}
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div style={{ marginBlockStart: "2rem" }}>
        <Eyebrow>why there is no bid button here</Eyebrow>
        <p className="auc-lede" style={{ marginBlockStart: "0.5rem" }}>
          Only dealers bid. NBFC users are excluded from bidding by role, not by
          geography, so the exclusion holds even for a lender sitting inside a
          lot&apos;s radius. This console is the seller&apos;s side: your stock,
          your prices, your bidders.
        </p>
      </div>
    </>
  );
}
