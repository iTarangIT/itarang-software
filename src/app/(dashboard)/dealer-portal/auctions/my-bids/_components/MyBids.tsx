"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CountdownRing, formatINR } from "@/components/auction/AuctionPrimitives";

interface BidRow {
  lot_id: string;
  lot_code: string;
  title: string | null;
  status: string;
  ends_at: string;
  your_best: number;
  current_bid: number;
  outcome: "leading" | "outbid" | "won" | "lost";
}

const TONE: Record<BidRow["outcome"], string> = {
  leading: "live",
  won: "live",
  outbid: "warn",
  lost: "muted",
};

const LABEL: Record<BidRow["outcome"], string> = {
  leading: "leading",
  won: "you won",
  outbid: "outbid",
  lost: "lost",
};

export function MyBids() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "dealer", "my-bids"],
    queryFn: async () => {
      const res = await fetch("/api/dealer/auctions/my-bids");
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Could not load your bids.");
      }
      return json.data as { items: BidRow[] };
    },
    refetchInterval: 10_000,
  });

  const items = data?.items ?? [];
  const live = items.filter((i) => i.status === "live");
  const done = items.filter((i) => i.status !== "live");

  return (
    <div className="auction-sheet">
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 className="auc-h1">My bids</h1>
        <p className="auc-lede">
          Every lot you have bid on. A bid is binding — winning means you have
          bought the pallet.
        </p>
      </header>

      {isError && (
        <div className="auc-chip" data-tone="warn" style={{ display: "block", padding: "0.75rem" }}>
          {error instanceof Error ? error.message : "Could not load your bids."}
        </div>
      )}

      {isLoading && <p className="auc-lede">Loading…</p>}

      {!isLoading && items.length === 0 && (
        <div
          style={{
            border: "1px dashed var(--auc-rule-strong)",
            padding: "2.5rem 1.5rem",
            textAlign: "center",
            color: "var(--auc-ink-2)",
          }}
        >
          <p style={{ fontFamily: "var(--auc-display)", fontSize: "1.125rem", color: "var(--auc-ink)" }}>
            You have not bid on anything yet
          </p>
          <Link
            href="/dealer-portal/auctions"
            className="auc-btn"
            style={{ textDecoration: "none", marginTop: "1rem", display: "inline-block" }}
          >
            Browse auctions
          </Link>
        </div>
      )}

      {[
        { key: "live", label: "Still running", rows: live },
        { key: "done", label: "Finished", rows: done },
      ]
        .filter((g) => g.rows.length > 0)
        .map((group) => (
          <section key={group.key} style={{ marginBottom: "2rem" }}>
            <div className="auc-eyebrow">
              {group.label} · {group.rows.length}
            </div>
            <div className="auc-grid">
              {group.rows.map((r) => (
                <article className="auc-card" key={r.lot_id}>
                  <div className="auc-card-head" data-status={r.status}>
                    <div style={{ minWidth: 0 }}>
                      <div className="auc-lotcode">{r.lot_code}</div>
                      <h3 className="auc-title">
                        <Link
                          href={`/dealer-portal/auctions/${r.lot_id}`}
                          style={{ color: "inherit", textDecoration: "none" }}
                        >
                          {r.title ?? "Battery lot"}
                        </Link>
                      </h3>
                    </div>
                    {r.status === "live" && <CountdownRing endsAt={r.ends_at} />}
                  </div>
                  <div className="auc-card-body">
                    <div className="auc-price-row">
                      <div>
                        <div className="auc-price-label">Your best bid</div>
                        <div className="auc-price">{formatINR(r.your_best)}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className="auc-price-label">Standing bid</div>
                        <div className="auc-lotcode">{formatINR(r.current_bid)}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="auc-chip" data-tone={TONE[r.outcome]}>
                        {LABEL[r.outcome]}
                      </span>
                      <Link
                        href={`/dealer-portal/auctions/${r.lot_id}`}
                        className="auc-btn"
                        data-variant="ghost"
                        style={{ textDecoration: "none" }}
                      >
                        {r.status === "live" ? "Bid again" : "View"}
                      </Link>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
