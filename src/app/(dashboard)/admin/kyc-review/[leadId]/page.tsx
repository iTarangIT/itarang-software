import CaseReview from "@/components/kyc/CaseReview";

export default async function CaseReviewPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <CaseReview leadId={leadId} />
    </div>
  );
}
