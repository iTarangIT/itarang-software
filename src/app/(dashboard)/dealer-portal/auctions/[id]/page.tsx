/**
 * E-234 — /dealer-portal/auctions/[id]
 *
 * The live lot page. Detail polls at 15s, price/deadline at 2s.
 */
import "@/app/auction-theme.css";
import { LotDetail } from "./_components/LotDetail";

export const dynamic = "force-dynamic";

export default async function DealerAuctionLotPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-6">
      <LotDetail lotId={id} />
    </div>
  );
}
