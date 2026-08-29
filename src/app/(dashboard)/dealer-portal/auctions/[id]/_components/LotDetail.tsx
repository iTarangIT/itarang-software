"use client";

/**
 * E-234 — the live lot detail + bidding surface (BRD §10, §11).
 *
 * Two queries with different cadences, on purpose:
 *   - the DETAIL (photos, items, history) is heavy and barely changes → 15s
 *   - the STATE (price, count, deadline, who leads) is tiny → 2s
 * Polling the whole detail every 2s would ship the photo list sixty times a
 * minute to move one number.
 *
 * `ends_at` comes from the STATE poll, not from the detail: anti-snipe moves
 * the deadline mid-auction, and a countdown pinned to the page-load value would
 * run out while the lot is still taking bids.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ConditionChip,
  CountdownRing,
  SohBar,
  StatusChip,
  formatINR,
} from "@/components/auction/AuctionPrimitives";
// Pure arithmetic, no database import — the same function the server raises the
// sanction from, so what a dealer is quoted before bidding is what they get.
import { refinanceSplit } from "@/lib/auction/refinance-split";

interface LotItem {
  serial: string;
  condition: string;
  capacity: string | null;
  model: string | null;
  soh: number | null;
  image_urls: string[];
}

interface LotDetail {
  lot_id: string;
  lot_code: string;
  title: string | null;
  status: string;
  quantity: number;
  conditions: string[];
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
  you_are_leading: boolean;
  your_max_bid: number | null;
  anti_snipe_seconds: number;
  auto_bid_max: number | null;
  items: LotItem[];
  bid_history: Array<{ amount: number; placed_at: string; is_yours: boolean }>;
}

interface LiveState {
  status: string;
  current_bid: number;
  bid_count: number;
  ends_at: string;
  you_are_leading: boolean;
  min_next_bid: number;
}

export function LotDetail({ lotId }: { lotId: string }) {
  const qc = useQueryClient();
  const [typedAmount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  const [autoMax, setAutoMax] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);

  // Lock the page behind the lightbox. Without this a phone scrolls the lot
  // underneath the photograph, and closing lands the bidder somewhere else on
  // the page than where they opened it.
  useEffect(() => {
    if (!lightbox) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [lightbox]);

  const detail = useQuery({
    queryKey: ["auction", "dealer", "detail", lotId],
    queryFn: async () => {
      const res = await fetch(`/api/dealer/auctions/${lotId}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Could not load this lot.");
      }
      return json.data as LotDetail;
    },
    refetchInterval: 15_000,
  });

  const live = useQuery({
    queryKey: ["auction", "dealer", "state", lotId],
    queryFn: async () => {
      const res = await fetch(`/api/dealer/auctions/${lotId}/state`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error("state unavailable");
      return json.data as LiveState;
    },
    refetchInterval: 2_000,
    refetchOnWindowFocus: true,
  });

  const lot = detail.data;
  const state = live.data;

  // The live poll wins on every field it carries — it is newer by up to 13s.
  const currentBid = state?.current_bid ?? lot?.current_bid ?? 0;
  const endsAt = state?.ends_at ?? lot?.ends_at;
  const status = state?.status ?? lot?.status ?? "live";
  const leading = state?.you_are_leading ?? lot?.you_are_leading ?? false;
  const minNext =
    state?.min_next_bid ??
    (currentBid === 0 ? (lot?.base_price ?? 0) : currentBid + (lot?.bid_increment ?? 0));

  // Keep the input at the minimum until the bidder types over it. Once they
  // have, leave it alone — overwriting what someone is typing every 2s is the
  // fastest way to make a live form unusable.
  //
  // DERIVED, not synced. This used to be a `useEffect` that called `setAmount`
  // on every change to `minNext` — a cascading render twice a second, from a
  // poll, for a value that is a pure function of state already in hand.
  const amount = touched || minNext <= 0 ? typedAmount : String(minNext);

  const bid = useMutation({
    mutationFn: async (value: number) => {
      const res = await fetch(`/api/dealer/auctions/${lotId}/bid`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: value, confirmed: true }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Bid failed.");
      }
      return json.data;
    },
    onSuccess: (data) => {
      if (data.accepted === false) {
        toast.error(
          `Too low — the next valid bid is ${formatINR(data.min_next_bid)}.`,
        );
        setAmount(String(data.min_next_bid));
        return;
      }
      if (data.outbid_by_proxy) {
        // Telling someone "bid placed" while they are already losing to a
        // standing order is the most misleading thing this screen could do.
        toast.warning(
          `Bid placed — but another dealer's standing maximum immediately went to ${formatINR(data.outbid_by_proxy)}.`,
        );
      } else if (data.extended) {
        toast.success("Bid placed. The deadline was extended — anti-snipe.");
      } else {
        toast.success(`Bid placed at ${formatINR(data.amount)}.`);
      }
      setTouched(false);
      qc.invalidateQueries({ queryKey: ["auction"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Bid failed."),
  });

  const autoBid = useMutation({
    mutationFn: async (max: number | null) => {
      const res = await fetch(`/api/dealer/auctions/${lotId}/auto-bid`, {
        method: max === null ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: max === null ? undefined : JSON.stringify({ max_amount: max }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Could not save your maximum.");
      }
      return json.data;
    },
    onSuccess: (_d, max) => {
      toast.success(
        max === null
          ? "Standing maximum cancelled."
          : `Standing maximum set at ${formatINR(max)}. We will bid the minimum needed to keep you in front, up to that.`,
      );
      qc.invalidateQueries({ queryKey: ["auction"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not save your maximum."),
  });

  if (detail.isLoading) {
    return <div className="auction-sheet auc-lede">Loading lot…</div>;
  }
  if (detail.isError || !lot) {
    return (
      <div className="auction-sheet">
        <h1 className="auc-h1">Lot unavailable</h1>
        <p className="auc-lede">
          {detail.error instanceof Error
            ? detail.error.message
            : "This lot is not available to your account."}
        </p>
        <Link href="/dealer-portal/auctions" className="auc-btn" style={{ textDecoration: "none" }}>
          Back to auctions
        </Link>
      </div>
    );
  }

  const isLive = status === "live";
  const windowMs = lot.starts_at
    ? new Date(lot.ends_at).getTime() - new Date(lot.starts_at).getTime()
    : undefined;
  const allPhotos = lot.items.flatMap((i) => i.image_urls);

  return (
    <div className="auction-sheet">
      <Link
        href="/dealer-portal/auctions"
        className="auc-lotcode"
        style={{ textDecoration: "none", display: "inline-block", marginBottom: "0.75rem" }}
      >
        ← All auctions
      </Link>

      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "1.5rem",
          flexWrap: "wrap",
          paddingBottom: "1rem",
          borderBottom: "2px solid var(--auc-ink)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="auc-lotcode">{lot.lot_code}</div>
          <h1 className="auc-h1">{lot.title ?? `${lot.quantity} battery lot`}</h1>
          <div className="auc-meta" style={{ marginTop: "0.5rem" }}>
            <span>
              <b>{lot.quantity}</b>&times; battery
            </span>
            <span>{lot.city ?? lot.state ?? "India"}</span>
            {lot.distance_km !== null && <span>{Math.round(lot.distance_km)} km away</span>}
            {lot.auction_type === "cash_refinance" && <span>cash + refinance</span>}
            {!isLive && <StatusChip status={status} />}
          </div>
        </div>
        {endsAt && <CountdownRing endsAt={endsAt} windowMs={windowMs} />}
      </header>

      <div
        className="auc-detail-grid"
        style={{ marginTop: "1.5rem" }}
      >
        {/* ---- left: photos + items ---- */}
        <section>
          {allPhotos.length > 0 && (
            <>
              <div className="auc-eyebrow">Photographs · captured at inspection</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
                  gap: "0.5rem",
                  marginBottom: "1.75rem",
                }}
              >
                {allPhotos.map((src) => (
                  <button
                    key={src}
                    onClick={() => setLightbox(src)}
                    style={{
                      padding: 0,
                      border: "1px solid var(--auc-rule)",
                      background: "none",
                      cursor: "zoom-in",
                      aspectRatio: "4 / 3",
                      overflow: "hidden",
                    }}
                    aria-label="Open photograph"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      alt=""
                      style={{ inlineSize: "100%", blockSize: "100%", objectFit: "cover" }}
                    />
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="auc-eyebrow">What is in this lot</div>

          {/* Wide: the ledger table. The five columns were previously forced
              into a horizontal scroller on every phone, which is the one place
              a bidder is most likely to be standing. */}
          <div className="auc-only-wide auc-scroll-x">
            <table className="auc-table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Model</th>
                  <th>Capacity</th>
                  <th>Condition</th>
                  <th>SOH</th>
                </tr>
              </thead>
              <tbody>
                {lot.items.map((i) => (
                  <tr key={i.serial}>
                    <td>
                      <span className="auc-lotcode">{i.serial}</span>
                    </td>
                    <td>{i.model ?? "—"}</td>
                    <td>{i.capacity ?? "—"}</td>
                    <td>
                      <ConditionChip condition={i.condition} />
                    </td>
                    <td>
                      <SohBar soh={i.soh} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Narrow: one card per battery. */}
          <div className="auc-only-narrow auc-stack">
            {lot.items.map((i) => (
              <article key={i.serial} className="auc-mini-card">
                <header>
                  <span className="auc-pick-serial">{i.serial}</span>
                  <ConditionChip condition={i.condition} />
                </header>
                <dl className="auc-dl">
                  <div>
                    <dt>Model</dt>
                    <dd>{i.model ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Capacity</dt>
                    <dd>{i.capacity ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>State of health</dt>
                    <dd>
                      <SohBar soh={i.soh} />
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </section>

        {/* ---- right: bidding ---- */}
        <aside style={{ position: "sticky", top: "1.5rem" }}>
          <div
            style={{
              border: "1px solid var(--auc-rule)",
              background: "var(--auc-card)",
              padding: "1.125rem",
            }}
          >
            <div className="auc-price-label">
              {lot.bid_count > 0 ? "Highest bid" : "Opening price"}
            </div>
            <div className="auc-price" style={{ marginBottom: "0.25rem" }}>
              {formatINR(currentBid > 0 ? currentBid : lot.base_price)}
            </div>
            <div className="auc-meta" style={{ marginBottom: "1rem" }}>
              <span>
                {state?.bid_count ?? lot.bid_count} bid
                {(state?.bid_count ?? lot.bid_count) === 1 ? "" : "s"}
              </span>
              {leading && (
                <span className="auc-chip" data-tone="live">
                  you lead
                </span>
              )}
              {!leading && lot.your_max_bid !== null && (
                <span className="auc-chip" data-tone="warn">
                  outbid
                </span>
              )}
            </div>

            {/* [BRD §13/§14] What "cash + refinance" actually costs, shown
                BEFORE the bid. The label has always been on the card; the
                numbers behind it were only discoverable after winning, which
                told a dealer the price of the lot but not the price of the
                deal. Derived from the same pure function the sanction is
                raised from, so the two can never disagree. */}
            {lot.auction_type === "cash_refinance" ? (
              (() => {
                const split = refinanceSplit(minNext);
                return (
                  <div className="auc-reach" style={{ marginBlockEnd: "0.875rem" }}>
                    <b>{formatINR(split.cash_due)} cash</b>
                    <p>
                      at the current minimum, with {formatINR(split.financed)}{" "}
                      financed over {split.tenure_months} months — about{" "}
                      {formatINR(split.indicative_emi)} a month. Indicative:
                      the final split is fixed against your winning bid.
                    </p>
                  </div>
                );
              })()
            ) : null}

            {isLive ? (
              <>
                <label className="auc-price-label" htmlFor="bid-amount">
                  Your bid — minimum {formatINR(minNext)}
                </label>
                <div className="auc-bidbar" style={{ marginTop: "0.375rem" }}>
                  <input
                    id="bid-amount"
                    className="auc-input"
                    type="number"
                    min={minNext}
                    step={lot.bid_increment}
                    value={amount}
                    onChange={(e) => {
                      setTouched(true);
                      setAmount(e.target.value);
                    }}
                  />
                  <button
                    className="auc-btn"
                    disabled={bid.isPending || Number(amount) < minNext}
                    onClick={() => bid.mutate(Number(amount))}
                  >
                    {bid.isPending ? "Placing…" : "Place bid"}
                  </button>
                </div>
                <p style={{ fontSize: "0.6875rem", color: "var(--auc-ink-2)", marginTop: "0.5rem" }}>
                  Bids are binding and cannot be withdrawn. A bid in the last{" "}
                  {lot.anti_snipe_seconds} seconds extends the auction by the same
                  amount.
                </p>

                <hr style={{ border: 0, borderTop: "1px solid var(--auc-rule)", margin: "1rem 0" }} />

                <div className="auc-price-label">Standing maximum</div>
                <p style={{ fontSize: "0.6875rem", color: "var(--auc-ink-2)", margin: "0.25rem 0 0.5rem" }}>
                  We bid the smallest amount needed to keep you in front, up to
                  this figure. You pay what it took to win, not your maximum.
                </p>
                {lot.auto_bid_max !== null ? (
                  <div className="auc-bidbar">
                    <span className="auc-input" style={{ display: "flex", alignItems: "center" }}>
                      {formatINR(lot.auto_bid_max)}
                    </span>
                    <button
                      className="auc-btn"
                      data-variant="ghost"
                      disabled={autoBid.isPending}
                      onClick={() => autoBid.mutate(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="auc-bidbar">
                    <input
                      className="auc-input"
                      type="number"
                      min={minNext}
                      placeholder={`e.g. ${minNext + lot.bid_increment * 10}`}
                      value={autoMax}
                      onChange={(e) => setAutoMax(e.target.value)}
                      aria-label="Standing maximum"
                    />
                    <button
                      className="auc-btn"
                      data-variant="ghost"
                      disabled={autoBid.isPending || !autoMax || Number(autoMax) < minNext}
                      onClick={() => autoBid.mutate(Number(autoMax))}
                    >
                      Set
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p style={{ fontSize: "0.8125rem", color: "var(--auc-ink-2)" }}>
                This auction is {status}. Bidding is closed.
              </p>
            )}
          </div>

          {lot.bid_history.length > 0 && (
            <div style={{ marginTop: "1.25rem" }}>
              <div className="auc-eyebrow">Bid history</div>
              {lot.bid_history.map((b, i) => (
                <div
                  key={`${b.placed_at}-${i}`}
                  className="auc-ticker-row"
                  data-yours={String(b.is_yours)}
                >
                  <span>{formatINR(b.amount)}</span>
                  <span style={{ color: "var(--auc-ink-2)" }}>
                    {new Date(b.placed_at).toLocaleString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              ))}
              <p style={{ fontSize: "0.6875rem", color: "var(--auc-ink-2)", marginTop: "0.5rem" }}>
                Bidder names are never shown — yours included, to everyone else.
              </p>
            </div>
          )}
        </aside>
      </div>

      {lightbox && (
        /* The `ref={(el) => el?.focus()}` this used to carry re-ran on EVERY
           render, so the 2-second live-state poll stole focus back from
           anything inside the dialog twice a second. Focus is taken once, on
           mount, by the close button. */
        <div
          className="auc-lightbox"
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => e.key === "Escape" && setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Photograph"
          tabIndex={-1}
          style={{ cursor: "zoom-out" }}
        >
          <button
            type="button"
            className="auc-lightbox-x"
            autoFocus
            onClick={(e) => {
              e.stopPropagation();
              setLightbox(null);
            }}
          >
            Close
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" />
        </div>
      )}

    </div>
  );
}
