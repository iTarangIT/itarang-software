/**
 * /dealer-portal/auctions/purchases — the buyer's side of a settlement.
 */
import "@/app/auction-theme.css";
import Script from "next/script";
import Link from "next/link";
import Purchases from "./_components/Purchases";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Auction purchases · iTarang",
};

export default function PurchasesPage() {
  return (
    <div className="p-4 md:p-6">
      {/* Razorpay's checkout widget. `lazyOnload` because most visits to this
          page are to check a status, not to pay — the component says so
          plainly if the script has not arrived when someone does pay. */}
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        strategy="lazyOnload"
      />
      <div className="auction-sheet">
        <div className="auc-sheet-head">
          <div>
            <h1 className="auc-h1">Your purchases</h1>
            <p className="auc-lede">
              Lots you have won. Pay here, then the seller dispatches — a
              battery cannot be marked on its way until the payment is on
              record.
            </p>
          </div>
          <div className="auc-head-actions">
            <Link
              href="/dealer-portal/auctions/my-bids"
              className="auc-btn"
              data-variant="ghost"
            >
              My bids
            </Link>
            <Link href="/dealer-portal/auctions" className="auc-btn">
              Browse auctions
            </Link>
          </div>
        </div>
        <Purchases />
      </div>
    </div>
  );
}
