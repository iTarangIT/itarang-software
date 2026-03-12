"use client";

import { useRouter } from "next/navigation";
import { useOnboardingStore } from "@/store/onboardingStore";

function ReviewCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-white">
      <div className="px-5 py-4 border-b border-[#E3E8EF]">
        <h3 className="text-lg font-semibold text-[#173F63]">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export default function StepReview() {
  const router = useRouter();

  const state = useOnboardingStore();
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const setField = useOnboardingStore((s) => s.setField);
  const errors = useOnboardingStore((s) => s.errors);
  const setErrors = useOnboardingStore((s) => s.setErrors);

  const handleSubmitApplication = () => {
    const submitErrors: Record<string, string> = {};

    if (!state.reviewChecks.confirmInfo) {
      submitErrors.confirmInfo = "Please confirm all information is correct";
    }

    if (!state.reviewChecks.confirmDocs) {
      submitErrors.confirmDocs = "Please confirm uploaded documents are valid";
    }

    if (!state.reviewChecks.agreeTerms) {
      submitErrors.agreeTerms = "Please agree to iTarang onboarding and dealer terms";
    }

    if (Object.keys(submitErrors).length > 0) {
      setErrors(submitErrors);
      return;
    }

    router.push("/dealer-portal");
  };

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 md:p-8 shadow-sm">
        <h2 className="text-2xl font-bold text-[#173F63]">Review Application</h2>
        <p className="text-slate-500 mt-1">
          Review your details before final submission.
        </p>
      </div>

      <ReviewCard title="Company Details">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-slate-700">
          <p>Company Name: {state.company.companyName || "—"}</p>
          <p>Company Type: {state.company.companyType || "—"}</p>
          <p>GST: {state.company.gstNumber || "—"}</p>
          <p>PAN: {state.company.companyPanNumber || "—"}</p>
          <p className="md:col-span-2">Address: {state.company.companyAddress || "—"}</p>
        </div>
      </ReviewCard>

      <ReviewCard title="Compliance Documents">
        <div className="space-y-2 text-sm text-slate-700">
          <p>ITR: {state.compliance.itr3Years?.file?.name || "Not uploaded"}</p>
          <p>Bank Statement: {state.compliance.bankStatement3Months?.file?.name || "Not uploaded"}</p>
          <p>Undated Cheques: {state.compliance.undatedCheques?.file?.name || "Not uploaded"}</p>
          <p>Passport Photo: {state.compliance.passportPhoto?.file?.name || "Not uploaded"}</p>
          <p>Udyam Certificate: {state.compliance.udyamCertificate?.file?.name || "Not uploaded"}</p>
        </div>
      </ReviewCard>

      <ReviewCard title="Ownership Details">
        <div className="space-y-2 text-sm text-slate-700">
          <p>Bank Name: {state.ownership.bankName || "—"}</p>
          <p>Account Number: {state.ownership.accountNumber || "—"}</p>
          <p>IFSC: {state.ownership.ifsc || "—"}</p>
          <p>Beneficiary Name: {state.ownership.beneficiaryName || "—"}</p>
        </div>
      </ReviewCard>

      <ReviewCard title="Finance Enablement Selection">
        <p className="text-sm text-slate-700">
          Finance Enabled: {state.finance.enableFinance === "yes" ? "Yes" : "No"}
        </p>
      </ReviewCard>

      <ReviewCard title="Dealer Agreement Status">
        <div className="space-y-2 text-sm text-slate-700">
          <p>Agreement required: {state.finance.enableFinance === "yes" ? "Yes" : "No"}</p>
          <p>Agreement status: {state.agreement.agreementStatus}</p>
          <p>Signer details: {state.agreement.dealerSignerName || "Pending"}</p>
        </div>
      </ReviewCard>

      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm space-y-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={state.reviewChecks.confirmInfo}
            onChange={(e) => setField("reviewChecks", "confirmInfo", e.target.checked)}
            className="mt-1"
          />
          <span>I confirm all information submitted is correct</span>
        </label>
        {errors.confirmInfo && (
          <p className="text-sm text-red-600">{errors.confirmInfo}</p>
        )}

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={state.reviewChecks.confirmDocs}
            onChange={(e) => setField("reviewChecks", "confirmDocs", e.target.checked)}
            className="mt-1"
          />
          <span>I confirm the uploaded documents are valid</span>
        </label>
        {errors.confirmDocs && (
          <p className="text-sm text-red-600">{errors.confirmDocs}</p>
        )}

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={state.reviewChecks.agreeTerms}
            onChange={(e) => setField("reviewChecks", "agreeTerms", e.target.checked)}
            className="mt-1"
          />
          <span>I agree to iTarang onboarding and dealer terms</span>
        </label>
        {errors.agreeTerms && (
          <p className="text-sm text-red-600">{errors.agreeTerms}</p>
        )}

        {Object.entries(errors)
          .filter(
            ([key]) =>
              !["confirmInfo", "confirmDocs", "agreeTerms"].includes(key)
          )
          .map(([key, error]) => (
            <p key={key} className="text-sm text-red-600">
              {error}
            </p>
          ))}
      </div>

      <div className="flex justify-between">
        <button
          type="button"
          onClick={prevStep}
          className="px-6 py-3 rounded-2xl border border-[#E3E8EF] text-slate-700 font-semibold"
        >
          ← Back
        </button>

        <button
          type="button"
          onClick={handleSubmitApplication}
          className="px-6 py-3 rounded-2xl bg-[#1F5C8F] text-white font-semibold hover:bg-[#173F63]"
        >
          Submit Dealer Application
        </button>
      </div>
    </div>
  );
}
