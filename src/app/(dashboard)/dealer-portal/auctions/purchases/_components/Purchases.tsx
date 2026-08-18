"use client";

/**
 * What the dealer won, and what happens next.
 *
 * "My bids" ended at the word "won". There was no amount owed, no way to pay,
 * no pickup state and no record afterwards — the buyer's half of a settlement
 * simply had no surface, because every settlement read was scoped to the
 * seller.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { dealerFetch, formatINR } from "@/lib/auction/client";
import { Eyebrow, ConditionChip } from "@/components/auction/AuctionPrimitives";

interface Purchase {
  settlement_id: string;
  lot_id: string;
  lot_code: string;
  title: string | null;
  auction_type: string;
  final_price: number;
  status: string;
  seller_name: string | null;
  paid_at: string | null;
  payment_ref: string | null;
  payment_provider: string | null;
  failure_reason: string | null;
  refinance_loan_id: string | null;
  updated_at: string;
  items: Array<{ serial: string; condition: string }>;
}

const STATUS_LABEL: Record<string, string> = {
  payment_pending: "Payment due",
  in_transit: "On its way",
  delivered: "Delivered",
};

const STATUS_TONE: Record<string, string> = {
  payment_pending: "warn",
  in_transit: "muted",
  delivered: "live",
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
    };
  }
}

export default function Purchases() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "dealer", "purchases"],
    queryFn: () =>
      dealerFetch<{ items: Purchase[] }>("/api/dealer/auctions/settlements"),
    refetchOnWindowFocus: true,
  });

  async function pay(p: Purchase) {
    setBusy(p.settlement_id);
    try {
      const intent = await dealerFetch<{
        amount: number;
        order_id: string | null;
        key_id: string | null;
        gateway_unavailable: boolean;
      }>(`/api/dealer/auctions/settlements/${p.settlement_id}/pay`, {
        method: "POST",
      });

      if (intent.gateway_unavailable || !intent.order_id || !intent.key_id) {
        // Said plainly rather than failing silently: the sale is valid and can
        // be settled by transfer, which the seller records against a reference.
        toast.message("Online payment is not available", {
          description:
            "Settle by bank transfer and send the reference to the seller — " +
            "they will record it against this purchase.",
        });
        return;
      }

      // Razorpay's checkout script is loaded by the page; if it is not there,
      // say so rather than throwing an opaque ReferenceError.
      if (typeof window === "undefined" || !window.Razorpay) {
        toast.error(
          "The payment window could not load. Check your connection and try again.",
        );
        return;
      }

      const rzp = new window.Razorpay({
        key: intent.key_id,
        order_id: intent.order_id,
        amount: intent.amount * 100,
        currency: "INR",
        name: "iTarang",
        description: `Auction lot ${p.lot_code}`,
        handler: async (resp: Record<string, string>) => {
          try {
            await dealerFetch(
              `/api/dealer/auctions/settlements/${p.settlement_id}/pay`,
              {
                method: "PATCH",
                body: JSON.stringify({
                  razorpay_order_id: resp.razorpay_order_id,
                  razorpay_payment_id: resp.razorpay_payment_id,
                  razorpay_signature: resp.razorpay_signature,
                }),
              },
            );
            toast.success("Payment received");
            qc.invalidateQueries({ queryKey: ["auction"] });
          } catch (e) {
            toast.error(
              e instanceof Error
                ? e.message
                : "The payment went through but could not be confirmed. Contact the seller with your reference.",
            );
          }
        },
      });
      rzp.open();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) {
    return (
      <div className="auc-stack">
        {[0, 1].map((i) => (
          <div key={i} className="auc-skel" style={{ height: "8rem" }} />
        ))}
      </div>
    );
  }

  if (isError) {
    return <div className="auc-inline-error">{(error as Error).message}</div>;
  }

  const items = data?.items ?? [];

  if (items.length === 0) {
    return (
      <div className="auc-empty">
        <p>Nothing won yet</p>
        <p className="auc-empty-hint">
          Lots you win appear here with the amount due and how to pay it. You
          will be notified the moment an auction you bid on closes.
        </p>
        <Link href="/dealer-portal/auctions" className="auc-btn">
          Browse auctions
        </Link>
      </div>
    );
  }

  return (
    <div className="auc-stack">
      {items.map((p) => (
        <article key={p.settlement_id} className="auc-mini-card">
          <header>
            <div style={{ minInlineSize: 0 }}>
              <Link
                href={`/dealer-portal/auctions/${p.lot_id}`}
                className="auc-title"
                style={{ textDecoration: "none", display: "block" }}
              >
                {p.title || p.lot_code}
              </Link>
              <span className="auc-lotcode">{p.lot_code}</span>
            </div>
            <span className="auc-chip" data-tone={STATUS_TONE[p.status]}>
              {STATUS_LABEL[p.status] ?? p.status}
            </span>
          </header>

          <dl className="auc-dl">
            <div>
              <dt>You pay</dt>
              <dd className="auc-num">{formatINR(p.final_price)}</dd>
            </div>
            <div>
              <dt>Seller</dt>
              <dd>{p.seller_name ?? "—"}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>
                {p.auction_type === "cash_refinance"
                  ? "Cash + refinance"
                  : "Cash"}
              </dd>
            </div>
            <div>
              <dt>Payment</dt>
              <dd>
                {p.paid_at ? (
                  <>
                    {new Date(p.paid_at).toLocaleDateString("en-IN")}
                    <span className="auc-subtle">
                      {p.payment_provider === "offline"
                        ? " · offline"
                        : " · online"}
                    </span>
                  </>
                ) : (
                  <span style={{ color: "var(--auc-warn)" }}>due</span>
                )}
              </dd>
            </div>
          </dl>

          {p.items.length > 0 ? (
            <div className="auc-meta" style={{ marginBlockStart: "0.625rem" }}>
              {p.items.slice(0, 6).map((i) => (
                <span key={i.serial} className="auc-winner">
                  <span className="auc-subtle">{i.serial}</span>
                  <ConditionChip condition={i.condition} />
                </span>
              ))}
            </div>
          ) : null}

          {p.refinance_loan_id ? (
            <p className="auc-hint" data-tone="ok">
              Financed — a loan has been raised against this purchase. Your EMI
              schedule is on the loans page.
            </p>
          ) : null}

          {p.failure_reason ? (
            <div className="auc-inline-error" style={{ marginBlockStart: "0.625rem" }}>
              {p.failure_reason}
            </div>
          ) : null}

          {!p.paid_at && p.status === "payment_pending" ? (
            <button
              type="button"
              className="auc-btn"
              disabled={busy === p.settlement_id}
              onClick={() => pay(p)}
            >
              {busy === p.settlement_id
                ? "Opening…"
                : `Pay ${formatINR(p.final_price)}`}
            </button>
          ) : null}
        </article>
      ))}

      <div style={{ marginBlockStart: "1rem" }}>
        <Eyebrow>how hand-over works</Eyebrow>
        <p className="auc-lede" style={{ marginBlockStart: "0.5rem" }}>
          Payment first, then dispatch. The seller cannot mark a battery on its
          way until the money is recorded — by the gateway, or against a
          transfer reference. Once it is delivered the battery is yours and the
          auction record closes.
        </p>
      </div>
    </div>
  );
}
