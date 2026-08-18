/**
 * /auctions — the public shop window (BRD §16).
 *
 * Outside the `(dashboard)` group, so it inherits no auth gate. Read-only by
 * construction: it renders `GET /api/public/auctions`, which carries no bidder
 * data, no reserve and no live bid — see that route for what is withheld and
 * why. Bidding requires a dealer login, so the only action here is "sign in".
 *
 * A server component with no client JavaScript at all: there is nothing to
 * interact with, and an anonymous visitor should not be made to download a
 * bidding bundle to look at a list.
 */
import "@/app/auction-theme.css";
import Link from "next/link";
import { headers } from "next/headers";

export const revalidate = 60;

export const metadata = {
  title: "Battery auctions · iTarang",
  description:
    "Refurbished and recovered lithium batteries offered for auction to iTarang dealers.",
};

interface PublicLot {
  lot_code: string;
  title: string | null;
  quantity: number;
  capacity: string | null;
  avg_soh: number | null;
  base_price: number;
  ends_at: string;
  auction_type: string;
  conditions: string[];
  image_url: string | null;
}

function inr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

function closesIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "closing now";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `closes in ${Math.floor(hours / 24)} d`;
  if (hours >= 1) return `closes in ${hours} h`;
  return `closes in ${Math.max(1, Math.floor(ms / 60_000))} min`;
}

async function loadLots(): Promise<PublicLot[]> {
  try {
    const h = await headers();
    const host = h.get("host");
    const proto = h.get("x-forwarded-proto") ?? "http";
    if (!host) return [];
    const res = await fetch(`${proto}://${host}/api/public/auctions`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.data?.items ?? []) as PublicLot[];
  } catch {
    // A marketing page must degrade to "nothing running" rather than a 500.
    return [];
  }
}

export default async function PublicAuctionsPage() {
  const lots = await loadLots();

  return (
    <main className="p-4 md:p-6">
      <div className="auction-sheet" style={{ maxInlineSize: "72rem", margin: "0 auto" }}>
        <div className="auc-sheet-head">
          <div>
            <h1 className="auc-h1">Battery auctions</h1>
            <p className="auc-lede">
              Recovered and refurbished lithium batteries, graded and priced by
              our NBFC partners. Bidding is open to approved iTarang dealers.
            </p>
          </div>
          <div className="auc-head-actions">
            <Link href="/login" className="auc-btn">
              Sign in to bid
            </Link>
          </div>
        </div>

        {lots.length === 0 ? (
          <div className="auc-empty">
            <p>No auctions running right now</p>
            <p className="auc-empty-hint">
              Lots open regularly and run for between two and forty-eight hours.
              Dealers are notified the moment one opens in their area.
            </p>
            <Link href="/login" className="auc-btn">
              Sign in
            </Link>
          </div>
        ) : (
          <div className="auc-grid">
            {lots.map((lot) => (
              <article key={lot.lot_code} className="auc-card">
                <div className="auc-card-head" data-status="live">
                  <div style={{ minInlineSize: 0 }}>
                    <span className="auc-title">
                      {lot.title || `${lot.quantity} battery lot`}
                    </span>
                    <span className="auc-lotcode">{lot.lot_code}</span>
                  </div>
                  <span className="auc-chip" data-tone="live">
                    {closesIn(lot.ends_at)}
                  </span>
                </div>

                <div className="auc-card-body">
                  <div className="auc-price-row">
                    <div>
                      <span className="auc-price-label">Opening price</span>
                      <span className="auc-price">{inr(lot.base_price)}</span>
                    </div>
                    <div>
                      <span className="auc-price-label">Batteries</span>
                      <span className="auc-price">{lot.quantity}</span>
                    </div>
                  </div>

                  <div className="auc-meta">
                    {lot.capacity ? <span>{lot.capacity}</span> : null}
                    {lot.avg_soh != null ? (
                      <span>
                        <b>{lot.avg_soh.toFixed(0)}%</b> avg SOH
                      </span>
                    ) : null}
                    {lot.auction_type === "cash_refinance" ? (
                      <span className="auc-chip">financing available</span>
                    ) : null}
                  </div>

                  <div className="auc-meta">
                    {lot.conditions.map((c) => (
                      <span key={c} className="auc-chip" data-condition={c}>
                        {c.replace("_", " ")}
                      </span>
                    ))}
                  </div>

                  <div className="auc-linkrow" style={{ marginBlockStart: "0.75rem" }}>
                    <Link href="/login" className="auc-btn">
                      Sign in to bid
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        <footer style={{ marginBlockStart: "2.5rem" }}>
          <div className="auc-eyebrow">how it works</div>
          <p className="auc-lede" style={{ marginBlockStart: "0.75rem" }}>
            Every battery here was recovered from a defaulted loan, inspected,
            graded on measured state of health and — where it was worth doing —
            refurbished with new accessories. Lots run for a fixed window; the
            highest bid at the deadline wins, and a bid in the final two minutes
            extends the clock so nothing is decided in the last second. Only
            approved dealers may bid, and the highest bid is visible to them
            while the bidder never is.
          </p>
        </footer>
      </div>
    </main>
  );
}
