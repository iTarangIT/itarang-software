import CaseReview from "@/components/kyc/CaseReview";
import ProductReviewLinkBanner from "@/components/kyc/ProductReviewLinkBanner";
import PushToDealerPanel from "@/components/kyc/PushToDealerPanel";
import DealerPaymentChip from "@/components/loans/DealerPaymentChip";

export default async function CaseReviewPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <ProductReviewLinkBanner leadId={leadId} />
      {/* E-298 — renders only once the loan is disbursed and the dealer was asked. */}
      <div className="mb-3 empty:hidden">
        <DealerPaymentChip leadId={leadId} />
      </div>
      {/* ID 33: Push to dealer (Admin / Sales Head) + push history. */}
      <PushToDealerPanel leadId={leadId} />
      <CaseReview leadId={leadId} />
    </div>
  );
}
