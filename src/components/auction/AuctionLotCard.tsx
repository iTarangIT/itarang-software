"use client";

/**
 * E-234 — one lot card in the dealer grid (BRD §10).
 *
 * Shows: image, serial count, condition mix, quantity, location, the HIGHEST
 * BID, and a countdown. It does NOT show who placed that bid, and the prop type
 * has no field for it — §11 is enforced by the API projection and reinforced
 * here by there being nothing to render.
 */
import Link from "next/link";
import {
  ConditionChip,
  CountdownRing,
  StatusChip,
  formatINR,
  formatINRCompact,
} from "./AuctionPrimitives";

export interface LotCardData {
  lot_id: string;
  lot_code: string;
  title: string | null;
  status: string;
  quantity: number;
  conditions: string[];
  capacity: string | null;
  avg_soh: number | null;
  base_price: number;
  bid_increment: number;
  current_bid: number;
  bid_count: number;
  starts_at: string | null;
  ends_at: string;
  auction_type: string;
  city: string | null;
  state: string | null;
  distance_km: number | null;
  image_url: string | null;
  you_are_leading: boolean;
  your_max_bid: number | null;
}

export function AuctionLotCard({ lot }: { lot: LotCardData }) {
  const hasBids = lot.bid_count > 0;
  // A dealer who has bid and is not leading has been outbid. Surfaced as a
  // data attribute so the stylesheet can restyle the whole card through
  // :has() without this component knowing what that looks like.
  const outbid = lot.your_max_bid !== null && !lot.you_are_leading;

  const windowMs = lot.starts_at
    ? new Date(lot.ends_at).getTime() - new Date(lot.starts_at).getTime()
    : undefined;

  return (
    <article className="auc-card">
      <div
        className="auc-card-head"
        data-status={lot.status}
        data-leading={String(lot.you_are_leading)}
        data-outbid={String(outbid)}
      >
        <div style={{ minWidth: 0 }}>
          <div className="auc-lotcode">{lot.lot_code}</div>
          <h3 className="auc-title">
            <Link
              href={`/dealer-portal/auctions/${lot.lot_id}`}
              style={{ color: "inherit", textDecoration: "none" }}
            >
              {lot.title ?? `${lot.quantity} battery lot`}
            </Link>
          </h3>
        </div>
        <CountdownRing endsAt={lot.ends_at} windowMs={windowMs} />
      </div>

      <div className="auc-card-body">
        <div className="auc-meta">
          <span>
            <b>{lot.quantity}</b>&times; battery
          </span>
          {lot.capacity && <span>{lot.capacity}</span>}
          {lot.avg_soh !== null && (
            <span>
              avg SOH <b>{Number(lot.avg_soh).toFixed(0)}%</b>
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
          {lot.conditions.map((c) => (
            <ConditionChip key={c} condition={c} />
          ))}
          {lot.auction_type === "cash_refinance" && (
            <span className="auc-chip" data-tone="muted">
              cash + refinance
            </span>
          )}
          {lot.status !== "live" && <StatusChip status={lot.status} />}
        </div>

        <div className="auc-price-row">
          <div>
            <div className="auc-price-label">
              {hasBids ? "Highest bid" : "Opening price"}
            </div>
            <div className="auc-price">
              {formatINR(hasBids ? lot.current_bid : lot.base_price)}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="auc-price-label">
              {hasBids ? `${lot.bid_count} bid${lot.bid_count === 1 ? "" : "s"}` : "no bids yet"}
            </div>
            <div className="auc-lotcode">
              +{formatINRCompact(lot.bid_increment)} min
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.5rem",
          }}
        >
          <span className="auc-meta" style={{ margin: 0 }}>
            {lot.city ?? lot.state ?? "India"}
            {lot.distance_km !== null && ` · ${Math.round(lot.distance_km)} km`}
          </span>

          {lot.you_are_leading ? (
            <span className="auc-chip" data-tone="live">
              you lead
            </span>
          ) : outbid ? (
            <span className="auc-chip" data-tone="warn">
              outbid
            </span>
          ) : null}

          <Link
            href={`/dealer-portal/auctions/${lot.lot_id}`}
            className="auc-btn"
            data-variant={lot.status === "live" ? undefined : "ghost"}
            style={{ textDecoration: "none" }}
          >
            {lot.status === "live" ? "Place bid" : "View"}
          </Link>
        </div>
      </div>
    </article>
  );
}
