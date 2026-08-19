/**
 * /nbfc/auction/compose/[id] — resume an existing draft.
 *
 * Separate from `/nbfc/auction/[id]`, which is the read-only seller view of a
 * lot that has already been published. A draft is still being written; a
 * published lot is a running auction. Two different screens, deliberately two
 * different URLs, so a link to one never opens the other.
 */
import "@/app/auction-theme.css";
import LotComposer from "../../_components/LotComposer";

export const dynamic = "force-dynamic";

export default async function ComposeDraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-4 md:p-6">
      <LotComposer lotId={id} />
    </div>
  );
}
