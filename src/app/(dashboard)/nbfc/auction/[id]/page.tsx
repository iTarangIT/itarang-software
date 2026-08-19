/**
 * /nbfc/auction/[id] — the seller's view of one lot.
 */
import "@/app/auction-theme.css";
import SellerLotDetail from "./_components/SellerLotDetail";

export const dynamic = "force-dynamic";

export default async function SellerLotPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-4 md:p-6">
      <SellerLotDetail lotId={id} />
    </div>
  );
}
