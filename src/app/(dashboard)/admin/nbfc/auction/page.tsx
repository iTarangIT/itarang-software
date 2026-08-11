/**
 * E-234 — /admin/nbfc/auction (Battery Auction BRD §21, NBFC Telemetry §6.3.4)
 *
 * The Auction Control Centre. Its eight endpoints shipped with E-069/E-070 and
 * have had no screen since — this is it.
 *
 * Route protection comes from `sharedRouteAccess` in src/middleware.ts, which
 * already covers `/admin/nbfc`; no middleware change was needed. Every endpoint
 * re-checks the admin role itself, because middleware deliberately skips /api.
 */
import "@/app/auction-theme.css";
import AuctionControlCentre from "@/components/admin/nbfc/AuctionControlCentre";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Auction Control Centre · iTarang",
};

export default function AdminAuctionControlPage() {
  return (
    <main className="mx-auto max-w-[100rem] p-6">
      <AuctionControlCentre />
    </main>
  );
}
