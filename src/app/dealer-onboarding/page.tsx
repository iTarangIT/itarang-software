"use client";

import OnboardingLayout from "@/components/onboarding/OnboardingLayout";
import { useOnboardingStore } from "@/store/onboardingStore";
import StepAgreement from "@/components/onboarding/steps/StepAgreement";
import StepCompany from "@/components/onboarding/steps/StepCompany";
import StepDocuments from "@/components/onboarding/steps/StepDocuments";
import StepFinance from "@/components/onboarding/steps/StepFinance";
import StepOwnership from "@/components/onboarding/steps/StepOwnership";
import StepReview from "@/components/onboarding/steps/StepReview";

function SubmissionSuccess() {
  const dealerId = useOnboardingStore((s) => s.dealerId);
  const companyName = useOnboardingStore((s) => s.company.companyName);

  return (
    <div className="flex items-center justify-center py-16">
      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-10 text-center max-w-lg shadow-sm">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <svg
            className="h-8 w-8 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-[#173F63]">
          Application Submitted
        </h2>
        <p className="mt-3 text-slate-600">
          Thank you{companyName ? `, ${companyName}` : ""}! Your dealer onboarding
          application has been submitted successfully.
        </p>
        {dealerId && (
          <p className="mt-2 text-sm text-slate-500">
            Dealer ID: <span className="font-semibold text-[#1F5C8F]">{dealerId}</span>
          </p>
        )}
        <p className="mt-4 text-sm text-slate-500">
          Our team will review your application and you will receive login
          credentials via email once approved.
        </p>
      </div>
    </div>
  );
}

export default function DealerOnboardingPage() {
  const step = useOnboardingStore((s) => s.step);
  const status = useOnboardingStore((s) => s.status);

  if (status === "under_review") {
    return (
      <OnboardingLayout>
        <SubmissionSuccess />
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout>
      {step === 1 && <StepCompany />}
      {step === 2 && <StepDocuments />}
      {step === 3 && <StepOwnership />}
      {step === 4 && <StepFinance />}
      {step === 5 && <StepAgreement />}
      {step === 6 && <StepReview />}
    </OnboardingLayout>
  );
}