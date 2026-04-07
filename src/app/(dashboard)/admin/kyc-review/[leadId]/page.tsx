import PANCard from "@/components/kyc/cards/PANCard";

export default async function CaseReviewPage({
  params,
}: {
  params: { leadId: string };
}) {
  // Fetch lead data from your DB here
  // const lead = await getLeadById(params.leadId);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">KYC Review</h1>
      <p className="text-gray-500 mb-6">Lead ID: {params.leadId}</p>

      {/* Add cards one by one */}
      <PANCard
        leadId={params.leadId}
        leadName="Vijay Sharma" // Replace with lead.full_name
        panNumber="ABCDE1234F" // Replace with lead.pan_number
        dob="1985-01-15" // Replace with lead.dob
      />

      {/* Next: Add BankCard, AadhaarCard etc. */}
    </div>
  );
}
