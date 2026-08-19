/**
 * /nbfc/auction/new — compose a fresh lot.
 *
 * A static segment, so it resolves ahead of `[id]` without an `exact` flag.
 */
import "@/app/auction-theme.css";
import LotComposer from "../_components/LotComposer";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Compose auction lot",
};

export default function NewLotPage() {
  return (
    <div className="p-4 md:p-6">
      <LotComposer />
    </div>
  );
}
