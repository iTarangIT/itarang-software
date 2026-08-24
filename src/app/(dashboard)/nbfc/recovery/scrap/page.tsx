/**
 * E-258 — /nbfc/recovery/scrap
 *
 * Where an NBFC turns the `scrap` column of the recovery board into money.
 * Scrap is excluded from the auction by design (a dealer bids on batteries that
 * still work), so until now the terminal `scrap` stage was where a battery went
 * to sit. iTarang buys it; this is the counter.
 */
import "@/app/auction-theme.css";
import Link from "next/link";
import ScrapDesk from "./_components/ScrapDesk";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Scrap sales · iTarang",
};

export default function NbfcScrapPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="auction-sheet">
        <div className="auc-sheet-head">
          <div>
            <p className="auc-eyebrow">Recovery · Scrap</p>
            <h1 className="auc-h1">Sell scrap to iTarang</h1>
            <p className="auc-lede">
              Bundle scrapped batteries into a consignment, attach the
              photographs, and name your rate per battery. iTarang answers with
              its own price; when you agree, iTarang pays and collects.
            </p>
          </div>
          <div className="auc-head-actions">
            <Link href="/nbfc/recovery" className="auc-btn" data-variant="ghost">
              Recovery board
            </Link>
            <Link
              href="/nbfc/recovery/batteries"
              className="auc-btn"
              data-variant="ghost"
            >
              Battery register
            </Link>
          </div>
        </div>
        <ScrapDesk />
      </div>
    </div>
  );
}
