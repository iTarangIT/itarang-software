/**
 * /nbfc/recovery/refurbishment — the workshop console (BRD §5, §15).
 */
import "@/app/auction-theme.css";
import Link from "next/link";
import RefurbishmentConsole from "./_components/RefurbishmentConsole";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Refurbishment jobs",
};

export default function RefurbishmentPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="auction-sheet">
        <div className="auc-sheet-head">
          <div>
            <h1 className="auc-h1">Refurbishment</h1>
            <p className="auc-lede">
              Repairs raised against recovered batteries. Refurbishment is
              recommended, never mandatory — a battery graded partial working
              goes straight to auction. What is spent here is rolled into the
              lot&apos;s opening price, accessories included.
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
              Batteries
            </Link>
          </div>
        </div>
        <RefurbishmentConsole />
      </div>
    </div>
  );
}
