/**
 * /nbfc/auction/drafts — lots that exist but have not been announced.
 */
import "@/app/auction-theme.css";
import Link from "next/link";
import DraftList from "./_components/DraftList";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Draft auction lots",
};

export default function DraftsPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="auction-sheet">
        <div className="auc-sheet-head">
          <div>
            <h1 className="auc-h1">Draft lots</h1>
            <p className="auc-lede">
              Nothing here is visible to a dealer. A draft becomes an auction
              only when you publish it, and publishing is the point at which the
              audience is frozen.
            </p>
          </div>
          <div className="auc-head-actions">
            <Link href="/nbfc/auction" className="auc-btn" data-variant="ghost">
              Running lots
            </Link>
            <Link href="/nbfc/auction/new" className="auc-btn">
              Compose a lot
            </Link>
          </div>
        </div>
        <DraftList />
      </div>
    </div>
  );
}
