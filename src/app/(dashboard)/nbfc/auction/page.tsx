/**
 * /nbfc/auction — the seller's lot console (BRD §7, §9, §12).
 *
 * Was a bidding marketplace. An NBFC does not bid: `auction_bids` moved to
 * dealer identity in E-232 and the NBFC bid route returns 403 by design, so the
 * "Enter lot → Place Bid" path on this page could only ever produce an error.
 * See `_components/SellerLotsConsole.tsx` for the full note.
 */
import "@/app/auction-theme.css";
import Link from "next/link";
import SellerLotsConsole from "./_components/SellerLotsConsole";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Auction lots",
};

export default function AuctionPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="auction-sheet">
        <div className="auc-sheet-head">
          <div>
            <h1 className="auc-h1">Your auction lots</h1>
            <p className="auc-lede">
              Batteries you have recovered, graded and put up for sale. Dealers
              bid; you set the price, the window and who can see it.
            </p>
          </div>
          <div className="auc-head-actions">
            <Link
              href="/nbfc/auction/drafts"
              className="auc-btn"
              data-variant="ghost"
            >
              Drafts
            </Link>
            <Link href="/nbfc/auction/new" className="auc-btn">
              Compose a lot
            </Link>
          </div>
        </div>

        <SellerLotsConsole />
      </div>
    </div>
  );
}
