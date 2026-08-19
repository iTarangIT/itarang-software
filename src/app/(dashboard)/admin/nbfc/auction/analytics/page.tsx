/**
 * /admin/nbfc/auction/analytics — is this recovering value?
 */
import "@/app/auction-theme.css";
import Link from "next/link";
import AuctionAnalytics from "./_components/AuctionAnalytics";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Auction analytics",
};

export default function AuctionAnalyticsPage() {
  return (
    <main className="mx-auto max-w-[100rem] p-4 md:p-6">
      <div className="auction-sheet">
        <div className="auc-sheet-head">
          <div>
            <h1 className="auc-h1">Auction performance</h1>
            <p className="auc-lede">
              What the auction channel is recovering, where value is leaking,
              and whether the scheduler that closes lots is actually running.
            </p>
          </div>
          <div className="auc-head-actions">
            <Link
              href="/admin/nbfc/auction"
              className="auc-btn"
              data-variant="ghost"
            >
              Control Centre
            </Link>
          </div>
        </div>
        <AuctionAnalytics />
      </div>
    </main>
  );
}
