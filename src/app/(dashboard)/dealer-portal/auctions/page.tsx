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
import { AuctionBrowser } from "./_components/AuctionBrowser";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Battery auctions · iTarang",
};

export default function DealerAuctionsPage() {
  return (
    <div className="p-6">
      <AuctionBrowser />
    </div>
  );
}
