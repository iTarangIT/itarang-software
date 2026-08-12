/**
 * E-234 — /dealer-portal/auctions/my-bids
 *
 * Every lot this dealer has bid on, with a resolved outcome. The outcome is
 * computed server-side (leading | outbid | won | lost) so this page, the grid
 * and the notification bell cannot end up disagreeing about what "lost" means.
 */
import "@/app/auction-theme.css";
import { MyBids } from "./_components/MyBids";

export const dynamic = "force-dynamic";

export const metadata = { title: "My bids · iTarang" };

export default function MyBidsPage() {
  return (
    <div className="p-6">
      <MyBids />
    </div>
  );
}
