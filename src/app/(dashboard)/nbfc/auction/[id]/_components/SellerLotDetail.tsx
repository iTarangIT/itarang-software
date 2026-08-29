"use client";

/**
 * The seller's view of one lot.
 *
 * `GET /api/nbfc/auction/lots/[id]` has existed since E-234 with no caller. It
 * is the one projection that carries bidder identity — a seller is entitled to
 * know who is bidding on their own stock, while the dealer-facing endpoint
 * deliberately never reveals it (BRD §11).
 *
 * It is also where a seller awards the lot, which until now only an iTarang
 * admin could do.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { nbfcFetch, formatINR } from "@/lib/auction/client";
import {
  CountdownRing,
  StatusChip,
  ConditionChip,
  Eyebrow,
} from "@/components/auction/AuctionPrimitives";

interface Bid {
  id: string;
  amount: number;
  placed_at: string;
  bidder_kind: string;
  bidder_dealer_id: string | null;
  bidder_name: string | null;
}

interface Visibility {
  scope: string;
  states: string[] | null;
  cities: string[] | null;
  radius_km: number | null;
}

interface LotResponse {
  lot: {
    lot_id: string;
    lot_code: string;
    title: string | null;
    status: string;
    quantity: number;
    base_price: number;
    bid_increment: number;
    reserve_price: number | null;
    auction_type: string;
    starts_at: string | null;
    ends_at: string;
    items: Array<{
      battery_id: string;
      serial: string;
      condition: string;
      item_price: number | null;
    }>;
  };
  visibility: Visibility | null;
  audience_dealers: number;
  bids: Bid[];
}

function describeScope(v: Visibility | null): string {
  if (!v) return "not published";
  if (v.scope === "india") return "All India";
  if (v.scope === "state") return `States — ${(v.states ?? []).join(", ")}`;
  if (v.scope === "city") return `Cities — ${(v.cities ?? []).join(", ")}`;
  return `Radius — ${v.radius_km ?? "?"} km`;
}

export default function SellerLotDetail({ lotId }: { lotId: string }) {
  const qc = useQueryClient();
  const [awarding, setAwarding] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "nbfc", "lot", lotId],
    queryFn: () => nbfcFetch<LotResponse>(`/api/nbfc/auction/lots/${lotId}`),
    // A live lot moves; a closed one does not. 10s is enough for a seller
    // watching their own auction without hammering the endpoint.
    refetchInterval: (q) =>
      (q.state.data as LotResponse | undefined)?.lot.status === "live"
        ? 10_000
        : false,
  });

  if (isLoading) {
    return (
      <div className="auction-sheet">
        <div className="auc-skel" style={{ height: "3rem", width: "50%" }} />
        <div
          className="auc-skel"
          style={{ height: "16rem", marginBlockStart: "1rem" }}
        />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="auction-sheet">
        <h1 className="auc-h1">Lot unavailable</h1>
        <p className="auc-lede">
          {isError ? (error as Error).message : "Not found."}
        </p>
        <Link href="/nbfc/auction" className="auc-btn">
          Back to lots
        </Link>
      </div>
    );
  }

  const { lot, visibility, audience_dealers, bids } = data;
  const top = bids[0] ?? null;
  const reserveMet =
    lot.reserve_price == null || (top?.amount ?? 0) >= lot.reserve_price;
  const closed = lot.status === "ended";

  async function award() {
    if (!top) return;
    const ok = await confirmDialog({
      title: "Award this lot?",
      message:
        `${top.bidder_name ?? top.bidder_dealer_id ?? "the top bidder"} wins at ` +
        `${formatINR(top.amount)}. A settlement opens and the batteries are marked sold. ` +
        "This cannot be undone.",
      confirmText: "Award",
    });
    if (!ok) return;

    setAwarding(true);
    try {
      await nbfcFetch(`/api/nbfc/auction/lots/${lotId}/approve-winner`, {
        method: "POST",
        body: JSON.stringify({ winning_bid_id: top.id }),
      });
      toast.success("Lot awarded — settlement opened");
      qc.invalidateQueries({ queryKey: ["auction"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAwarding(false);
    }
  }

  return (
    <div className="auction-sheet">
      <div className="auc-sheet-head">
        <div>
          <h1 className="auc-h1">{lot.title || lot.lot_code}</h1>
          <p className="auc-lede">
            <span className="auc-lotcode">{lot.lot_code}</span>{" "}
            <StatusChip status={lot.status} />{" "}
            {lot.auction_type === "cash_refinance" ? (
              <span className="auc-chip">cash + refinance</span>
            ) : null}
          </p>
        </div>
        <div className="auc-head-actions">
          {lot.status === "draft" ? (
            <Link
              href={`/nbfc/auction/compose/${lot.lot_id}`}
              className="auc-btn"
            >
              Continue editing
            </Link>
          ) : null}
          <Link href="/nbfc/auction" className="auc-btn" data-variant="ghost">
            All lots
          </Link>
        </div>
      </div>

      <div className="auc-kpis">
        <div className="auc-kpi">
          <b>{formatINR(top?.amount ?? lot.base_price)}</b>
          <span>{top ? "current bid" : "opening price"}</span>
        </div>
        <div className="auc-kpi">
          <b>{bids.length}</b>
          <span>bids</span>
        </div>
        <div className="auc-kpi">
          <b>{audience_dealers}</b>
          <span>dealers reached</span>
        </div>
        <div className="auc-kpi" data-tone={reserveMet ? "live" : "warn"}>
          <b>
            {lot.reserve_price != null ? formatINR(lot.reserve_price) : "none"}
          </b>
          <span>{reserveMet ? "reserve met" : "reserve not met"}</span>
        </div>
        <div className="auc-kpi">
          <b>{lot.quantity}</b>
          <span>batteries</span>
        </div>
      </div>

      <div className="auc-detail-grid">
        <div>
          <Eyebrow>batteries in this lot</Eyebrow>
          <div className="auc-stack" style={{ marginBlockStart: "0.75rem" }}>
            {lot.items.map((i) => (
              <article key={i.battery_id} className="auc-mini-card">
                <header>
                  <span className="auc-pick-serial">{i.serial}</span>
                  <ConditionChip condition={i.condition} />
                </header>
                <dl className="auc-dl">
                  <div>
                    <dt>Item price</dt>
                    <dd className="auc-num">{formatINR(i.item_price)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>

          <div style={{ marginBlockStart: "1.75rem" }}>
            <Eyebrow>bid history — seller view</Eyebrow>
            {bids.length === 0 ? (
              <div className="auc-empty" style={{ marginBlockStart: "0.75rem" }}>
                <p>No bids yet</p>
                <p className="auc-empty-hint">
                  {lot.status === "live"
                    ? "The lot is live and its audience has been notified."
                    : "This lot has not opened for bidding yet."}
                </p>
              </div>
            ) : (
              <>
                <div
                  className="auc-only-wide auc-scroll-x"
                  style={{ marginBlockStart: "0.75rem" }}
                >
                  <table className="auc-table">
                    <thead>
                      <tr>
                        <th className="auc-num">Amount</th>
                        <th>Bidder</th>
                        <th>Placed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bids.map((b) => (
                        <tr key={b.id}>
                          <td className="auc-num">{formatINR(b.amount)}</td>
                          <td>
                            <div className="auc-winner">
                              <span>
                                {b.bidder_name ??
                                  b.bidder_dealer_id ??
                                  "unknown"}
                              </span>
                              <span
                                className="auc-chip"
                                data-tone={
                                  b.bidder_kind === "dealer" ? "live" : "muted"
                                }
                              >
                                {b.bidder_kind}
                              </span>
                            </div>
                          </td>
                          <td className="auc-subtle">
                            {new Date(b.placed_at).toLocaleString("en-IN")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div
                  className="auc-only-narrow auc-stack"
                  style={{ marginBlockStart: "0.75rem" }}
                >
                  {bids.map((b) => (
                    <article key={b.id} className="auc-mini-card">
                      <header>
                        <span className="auc-price">
                          {formatINR(b.amount)}
                        </span>
                        <span
                          className="auc-chip"
                          data-tone={
                            b.bidder_kind === "dealer" ? "live" : "muted"
                          }
                        >
                          {b.bidder_kind}
                        </span>
                      </header>
                      <dl className="auc-dl">
                        <div>
                          <dt>Bidder</dt>
                          <dd>
                            {b.bidder_name ?? b.bidder_dealer_id ?? "unknown"}
                          </dd>
                        </div>
                        <div>
                          <dt>Placed</dt>
                          <dd className="auc-subtle">
                            {new Date(b.placed_at).toLocaleString("en-IN")}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <aside>
          {lot.status === "live" || lot.status === "scheduled" ? (
            <div style={{ marginBlockEnd: "1.25rem" }}>
              <CountdownRing endsAt={lot.ends_at} />
            </div>
          ) : null}

          <div className="auc-mini-card">
            <header>
              <span className="auc-label">Window &amp; reach</span>
            </header>
            <dl className="auc-dl">
              <div>
                <dt>Opens</dt>
                <dd className="auc-subtle">
                  {lot.starts_at
                    ? new Date(lot.starts_at).toLocaleString("en-IN")
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Closes</dt>
                <dd className="auc-subtle">
                  {new Date(lot.ends_at).toLocaleString("en-IN")}
                </dd>
              </div>
              <div>
                <dt>Visibility</dt>
                <dd>{describeScope(visibility)}</dd>
              </div>
              <div>
                <dt>Increment</dt>
                <dd className="auc-num">{formatINR(lot.bid_increment)}</dd>
              </div>
            </dl>
          </div>

          {closed ? (
            <div className="auc-mini-card" style={{ marginBlockStart: "1rem" }}>
              <header>
                <span className="auc-label">Award</span>
              </header>
              {!top ? (
                <p className="auc-hint">
                  The lot closed with no bids. The batteries have been returned
                  to ready and can be listed again.
                </p>
              ) : !reserveMet ? (
                <p className="auc-hint" data-tone="warn">
                  The top bid of {formatINR(top.amount)} is below your reserve of{" "}
                  {formatINR(lot.reserve_price)}. No settlement was created and
                  the batteries are back at ready.
                </p>
              ) : (
                <>
                  <p className="auc-hint">
                    Highest bid: <b>{formatINR(top.amount)}</b> from{" "}
                    {top.bidder_name ?? top.bidder_dealer_id}. Awarding opens a
                    settlement and marks the batteries sold.
                  </p>
                  <button
                    type="button"
                    className="auc-btn"
                    disabled={awarding}
                    onClick={award}
                  >
                    {awarding ? "Awarding…" : "Award to highest bidder"}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
