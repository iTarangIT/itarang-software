import CaseReview from "@/components/kyc/CaseReview";
import ProductReviewLinkBanner from "@/components/kyc/ProductReviewLinkBanner";
import PushToDealerPanel from "@/components/kyc/PushToDealerPanel";
import DealerCheckBanner from "@/components/leads/DealerCheckBanner";
import SchemePickCard from "@/components/leads/SchemePickCard";
import ResumeRejectedPanel from "@/components/leads/ResumeRejectedPanel";
import ActForDealerPanel from "@/components/kyc/ActForDealerPanel";
import KycTimeline from "@/components/kyc/KycTimeline";
import DealerPaymentChip from "@/components/loans/DealerPaymentChip";
import { getSessionUser } from "@/lib/nbfc/tenant";
import { isActForDealerRole } from "@/lib/leads/actForDealer";

export default async function CaseReviewPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  // ID 183 (18 Oct): only Admin / Sales Head may re-issue a consent (send-consent refuses the CEO).
  const canActForDealer = isActForDealerRole((await getSessionUser())?.role);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <ProductReviewLinkBanner leadId={leadId} />
      {/* E-298 — renders only once the loan is disbursed and the dealer was asked. */}
      <div className="mb-3 empty:hidden">
        <DealerPaymentChip leadId={leadId} />
      </div>
      {/* E-390: the dealer-assignment check, while it is open or rejected. */}
      <div className="mb-3 empty:hidden">
        <DealerCheckBanner leadId={leadId} admin />
      </div>
      {/* 23 Nov 2026 — NBFC rejected the file: resume it after corrected
          documents (same dealer, or a new case for another dealer). */}
      <ResumeRejectedPanel leadId={leadId} />
      {/* E-394 — admin / sales head choose the NBFC scheme before the file goes out. */}
      <SchemePickCard leadId={leadId} />
      {/* ID 33: Push to dealer (Admin / Sales Head) + push history. */}
      <PushToDealerPanel leadId={leadId} />
      {/* ID 183: Act for dealer (Admin / Sales Head) — renders nothing for others. */}
      <ActForDealerPanel leadId={leadId} />
      {/* KYC history: who did what on this file's KYC, and when. */}
      <KycTimeline leadId={leadId} />
      <CaseReview leadId={leadId} canRegenerateConsent={canActForDealer} />
    </div>
  );
}
