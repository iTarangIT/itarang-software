/**
 * /nbfc/recovery/batteries — the battery master (BRD §3).
 */
import "@/app/auction-theme.css";
import Link from "next/link";
import BatteryRegister from "./_components/BatteryRegister";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Recovered batteries",
};

export default function BatteriesPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="auction-sheet">
        <div className="auc-sheet-head">
          <div>
            <p className="auc-eyebrow">Recovery · Battery master</p>
            <h1 className="auc-h1">Recovered batteries</h1>
            <p className="auc-lede">
              One row per physical battery, from the moment it reaches the
              collection centre to the moment it is sold or scrapped. The
              photographs taken here are the ones a dealer bids on.
            </p>
          </div>
          <div className="auc-head-actions">
            <Link href="/nbfc/recovery" className="auc-btn" data-variant="ghost">
              Recovery board
            </Link>
            <Link href="/nbfc/auction/new" className="auc-btn">
              Compose a lot
            </Link>
          </div>
        </div>
        <BatteryRegister />
      </div>
    </div>
  );
}
