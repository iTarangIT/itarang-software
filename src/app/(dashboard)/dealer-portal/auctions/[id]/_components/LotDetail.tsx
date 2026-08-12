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
  const [amount, setAmount] = useState("");
  const [autoMax, setAutoMax] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);

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
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched && minNext > 0) setAmount(String(minNext));
  }, [minNext, touched]);

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
          <div className="auc-scroll-x">
            <table style={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
              <thead>
                <tr>
                  {["Serial", "Model", "Capacity", "Condition", "SOH"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "0.5rem 0.75rem 0.5rem 0",
                        borderBottom: "1px solid var(--auc-ink)",
                        fontFamily: "var(--auc-mono)",
                        fontSize: "0.5625rem",
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        color: "var(--auc-ink-2)",
                        fontWeight: 600,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lot.items.map((i) => (
                  <tr key={i.serial}>
                    <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", borderBottom: "1px solid var(--auc-rule)", fontFamily: "var(--auc-mono)", fontSize: "0.75rem" }}>
                      {i.serial}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", borderBottom: "1px solid var(--auc-rule)" }}>
                      {i.model ?? "—"}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", borderBottom: "1px solid var(--auc-rule)" }}>
                      {i.capacity ?? "—"}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", borderBottom: "1px solid var(--auc-rule)" }}>
                      <ConditionChip condition={i.condition} />
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem 0.5rem 0", borderBottom: "1px solid var(--auc-rule)" }}>
                      <SohBar soh={i.soh} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
        <div
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => e.key === "Escape" && setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Photograph"
          tabIndex={-1}
          ref={(el) => el?.focus()}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgb(2 4 10 / 0.9)",
            display: "grid",
            placeItems: "center",
            padding: "2rem",
            cursor: "zoom-out",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt=""
            style={{ maxInlineSize: "100%", maxBlockSize: "100%", objectFit: "contain" }}
          />
        </div>
      )}

    </div>
  );
}
