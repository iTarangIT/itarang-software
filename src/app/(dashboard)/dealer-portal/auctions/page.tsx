/**
 * E-234 — /dealer-portal/auctions (Battery Auction BRD §10)
 *
 * The dealer-facing auction surface. None existed before this: the only auction
 * UI in the app was NBFC-side, and the BRD requires dealers to be the only
 * bidders.
 *
 * No middleware change was needed — `/dealer-portal` is already a protected
 * prefix in `roleDashboards` (src/middleware.ts), so this route inherits the
 * dealer gate. The API routes still enforce it themselves, because middleware
 * deliberately skips `/api`.
 */
import "@/app/auction-theme.css";
import { Suspense } from "react";
import { AuctionBrowser } from "./_components/AuctionBrowser";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Battery auctions · iTarang",
};

export default function DealerAuctionsPage() {
  return (
    // The browser reads its filters from the query string so a search can be
    // bookmarked and shared. `useSearchParams` needs a Suspense boundary above
    // it or the whole route opts out of static rendering with a build warning.
    <div className="p-4 md:p-6">
      <Suspense
        fallback={
          <div className="auction-sheet">
            <div className="auc-skel" style={{ height: "3rem", width: "45%" }} />
            <div
              className="auc-skel"
              style={{ height: "20rem", marginBlockStart: "1.5rem" }}
            />
          </div>
        }
      >
        <AuctionBrowser />
      </Suspense>
    </div>
  );
}
