/**
 * E-258 — /admin/nbfc/scrap
 *
 * iTarang's side of the scrap trade: what the NBFCs are offering, what it
 * would cost, and the button that pays for it.
 *
 * Route protection comes from `sharedRouteAccess` in src/middleware.ts, which
 * already covers `/admin/nbfc`; no middleware change was needed. The endpoints
 * re-check the role themselves — middleware deliberately skips /api — and
 * narrow it further for anything that moves money.
 */
import "@/app/auction-theme.css";
import ScrapPurchaseDesk from "@/components/admin/nbfc/ScrapPurchaseDesk";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Scrap Purchase Desk · iTarang",
};

export default function AdminScrapPage() {
  return (
    <main className="mx-auto max-w-[100rem] p-6">
      <ScrapPurchaseDesk />
    </main>
  );
}
