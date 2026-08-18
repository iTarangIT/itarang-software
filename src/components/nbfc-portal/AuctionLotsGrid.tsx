"use client";

/**
 * Read-only grid of a seller's live lots.
 *
 * WHAT CHANGED
 *   This used to open `PlaceBidModal` from an "Enter lot" button. NBFCs do not
 *   bid — `auction_bids` moved to dealer identity in E-232 and
 *   `/api/nbfc/auction/lots/[id]/bid` has returned 403 by design ever since, so
 *   that button could only ever produce an error. The modal has been deleted;
 *   the card now links to the seller's own lot page, which is where the useful
 *   actions (watch the bidding, award the winner) actually live.
 *
 *   It also renders in the auction theme rather than hand-rolled Tailwind, so
 *   it matches the rest of the module and gets the responsive behaviour for
 *   free.
 */
import Link from "next/link";
import {
  CountdownRing,
  SohBar,
  formatINR,
} from "@/components/auction/AuctionPrimitives";

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
  /**
   * Retained for the recovery page, which renders this grid in a narrower
   * column than the standalone console. The theme's own auto-fill grid handles
   * every other case.
   */
  columnsClassName?: string;
}

export function AuctionLotsGrid({ lots }: AuctionLotsGridProps) {
  if (lots.length === 0) {
    return (
      <div className="auction-sheet">
        <div className="auc-empty">
          <p>No live auctions</p>
          <p className="auc-empty-hint">
            Compose a lot from batteries that are ready to sell, then publish it
            to open bidding.
          </p>
          <Link href="/nbfc/auction/new" className="auc-btn">
            Compose a lot
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auction-sheet">
      <div className="auc-grid">
        {lots.map((lot) => {
          const hasBids = lot.bidder_count > 0;
          return (
            <article key={lot.lot_id} className="auc-card">
              <div className="auc-card-head" data-status="live">
                <div style={{ minInlineSize: 0 }}>
                  <Link
                    href={`/nbfc/auction/${lot.lot_id}`}
                    className="auc-title"
                    style={{ textDecoration: "none", display: "block" }}
                  >
                    {lot.lot_code ?? "Lot"}
                  </Link>
                  <span className="auc-lotcode">
                    {lot.quantity} batter{lot.quantity === 1 ? "y" : "ies"}
                    {lot.capacity ? ` · ${lot.capacity}` : ""}
                  </span>
                </div>
                <CountdownRing endsAt={lot.ends_at} />
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
                  <SohBar soh={lot.avg_soh} />
                  {lot.age_months != null ? (
                    <span>
                      <b>{lot.age_months}</b> months old
                    </span>
                  ) : null}
                </div>

                <div className="auc-linkrow" style={{ marginBlockStart: "0.75rem" }}>
                  <Link href={`/nbfc/auction/${lot.lot_id}`} className="auc-btn">
                    Open lot
                  </Link>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export default AuctionLotsGrid;
