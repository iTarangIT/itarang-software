"use client";

/**
 * Auction KPIs, and the scheduler health card.
 *
 * The health card is on this page rather than buried in an ops dashboard
 * because of what it watches: the ONLY thing that closes an auction is an
 * in-process 15-second ticker. If the web process is not running it, bidding
 * continues past every deadline and no settlement is ever booked — silently.
 * "Lots past their deadline, still live" is that failure, stated as a number.
 */
import { useQuery } from "@tanstack/react-query";
import { nbfcFetch, formatINR } from "@/lib/auction/client";
import { Eyebrow } from "@/components/auction/AuctionPrimitives";

interface Health {
  healthy: boolean;
  overdue_lots: number;
  overdue_opens: number;
  live_lots: number;
  last_close_at: string | null;
  outbox_pending: number;
  outbox_failed: number;
}

interface Analytics {
  window_days: number;
  closed_lots: number;
  settlements: number;
  sell_through: number | null;
  no_bid_lots: number;
  no_bid_rate: number | null;
  reserve_not_met: number;
  realised_value: number;
  base_value: number;
  realisation_ratio: number | null;
  avg_bids_per_lot: number;
  avg_reach: number;
  avg_bidders: number;
  engagement_rate: number | null;
  avg_minutes_to_first_bid: number;
  paid_settlements: number;
  refinanced: number;
}

const pct = (v: number | null) =>
  v == null ? "—" : `${Math.round(v * 100)}%`;

export default function AuctionAnalytics() {
  const health = useQuery({
    queryKey: ["auction", "admin", "health"],
    queryFn: () => nbfcFetch<Health>("/api/admin/nbfc/auction/health"),
    refetchInterval: 30_000,
  });

  const kpi = useQuery({
    queryKey: ["auction", "admin", "analytics"],
    queryFn: () => nbfcFetch<Analytics>("/api/admin/nbfc/auction/analytics"),
    staleTime: 60_000,
  });

  const h = health.data;
  const k = kpi.data;

  return (
    <>
      <Eyebrow>scheduler</Eyebrow>
      {health.isLoading ? (
        <div className="auc-skel" style={{ height: "6rem", marginBlockTop: "0.75rem" }} />
      ) : health.isError ? (
        <div className="auc-inline-error">
          {(health.error as Error).message}
        </div>
      ) : h ? (
        <div
          className="auc-reach"
          data-tone={h.healthy ? undefined : "warn"}
          style={{ marginBlockStart: "0.75rem", marginBlockEnd: "1.75rem" }}
        >
          <b>
            {h.healthy
              ? "Closing lots on time"
              : `${h.overdue_lots + h.overdue_opens} lot${
                  h.overdue_lots + h.overdue_opens === 1 ? "" : "s"
                } stuck`}
          </b>
          <p>
            {h.healthy
              ? `${h.live_lots} live. Last close ${
                  h.last_close_at
                    ? new Date(h.last_close_at).toLocaleString("en-IN")
                    : "— none recorded yet"
                }.`
              : `${h.overdue_lots} past their deadline and still live, ${h.overdue_opens} scheduled but not opened. ` +
                "The auction ticker runs in the web process — if that process is not running it, nothing closes a lot at all. " +
                "Check the app is up, or drive /api/cron/auction/tick from the VPS crontab."}
            {h.outbox_pending > 0 || h.outbox_failed > 0
              ? ` Announcements: ${h.outbox_pending} queued, ${h.outbox_failed} failed.`
              : ""}
          </p>
        </div>
      ) : null}

      <Eyebrow>last {k?.window_days ?? 90} days</Eyebrow>

      {kpi.isLoading ? (
        <div className="auc-kpis" style={{ marginBlockStart: "0.75rem" }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="auc-kpi">
              <div className="auc-skel" style={{ height: "1.75rem" }} />
            </div>
          ))}
        </div>
      ) : kpi.isError ? (
        <div className="auc-inline-error">{(kpi.error as Error).message}</div>
      ) : k ? (
        <>
          <div className="auc-kpis" style={{ marginBlockStart: "0.75rem" }}>
            <div className="auc-kpi" data-tone="live">
              <b>{pct(k.sell_through)}</b>
              <span>sell-through</span>
            </div>
            <div
              className="auc-kpi"
              data-tone={
                k.realisation_ratio != null && k.realisation_ratio >= 1
                  ? "live"
                  : "warn"
              }
            >
              <b>{pct(k.realisation_ratio)}</b>
              <span>of base price realised</span>
            </div>
            <div className="auc-kpi">
              <b>{formatINR(k.realised_value)}</b>
              <span>value recovered</span>
            </div>
            <div className="auc-kpi" data-tone={k.no_bid_lots > 0 ? "warn" : undefined}>
              <b>{pct(k.no_bid_rate)}</b>
              <span>closed with no bid</span>
            </div>
            <div className="auc-kpi">
              <b>{k.avg_bids_per_lot.toFixed(1)}</b>
              <span>bids per lot</span>
            </div>
            <div className="auc-kpi">
              <b>{pct(k.engagement_rate)}</b>
              <span>of dealers reached bid</span>
            </div>
            <div className="auc-kpi">
              <b>
                {k.avg_minutes_to_first_bid > 0
                  ? `${Math.round(k.avg_minutes_to_first_bid)}m`
                  : "—"}
              </b>
              <span>to first bid</span>
            </div>
            <div className="auc-kpi" data-tone={k.reserve_not_met > 0 ? "warn" : undefined}>
              <b>{k.reserve_not_met}</b>
              <span>below reserve</span>
            </div>
            <div className="auc-kpi">
              <b>{k.paid_settlements}</b>
              <span>paid settlements</span>
            </div>
            <div className="auc-kpi">
              <b>{k.refinanced}</b>
              <span>refinanced</span>
            </div>
          </div>

          <div style={{ marginBlockStart: "1.75rem" }}>
            <Eyebrow>reading these</Eyebrow>
            <p className="auc-lede" style={{ marginBlockStart: "0.5rem" }}>
              <b>Realisation</b> above 100% means the auction beat the price the
              inspection put on the stock — the single number that answers
              whether auctioning is better than scrapping.{" "}
              <b>Dealers reached who bid</b> is the marketing figure: reach is
              how many were told, and the gap between the two is the audience
              rule being too wide, or the announcement not landing.{" "}
              <b>Below reserve</b> is value leaking out the other way — those
              lots closed with a bidder willing to pay, and the floor refused
              them.
            </p>
          </div>
        </>
      ) : null}
    </>
  );
}
