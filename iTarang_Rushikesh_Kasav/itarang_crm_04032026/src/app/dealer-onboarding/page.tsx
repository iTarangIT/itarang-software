"use client";

import OnboardingLayout from "@/components/onboarding/OnboardingLayout";
import { useOnboardingStore } from "@/store/onboardingStore";
import StepAgreement from "@/components/onboarding/steps/StepAgreement";
import StepCompany from "@/components/onboarding/steps/StepCompany";
import StepDocuments from "@/components/onboarding/steps/StepDocuments";
import StepFinance from "@/components/onboarding/steps/StepFinance";
import StepOwnership from "@/components/onboarding/steps/StepOwnership";
import StepReview from "@/components/onboarding/steps/StepReview";

export default function DealerOnboardingPage() {
  const step = useOnboardingStore((s) => s.step);

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