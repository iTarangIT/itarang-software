"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import OnboardingLayout from "@/components/onboarding/OnboardingLayout";
import OnboardingHydrator from "@/components/onboarding/OnboardingHydrator";
import OnboardingChooser from "@/components/onboarding/OnboardingChooser";
import { useOnboardingStore } from "@/store/onboardingStore";
import StepAgreement from "@/components/onboarding/steps/StepAgreement";
import StepCompany from "@/components/onboarding/steps/StepCompany";
import StepDocuments from "@/components/onboarding/steps/StepDocuments";
import StepFinance from "@/components/onboarding/steps/StepFinance";
import StepOwnership from "@/components/onboarding/steps/StepOwnership";
import StepReview from "@/components/onboarding/steps/StepReview";

function OnboardingPageInner() {
  const searchParams = useSearchParams();
  const applicationId = searchParams.get("applicationId");
  const step = useOnboardingStore((s) => s.step);
  const [startedNew, setStartedNew] = useState(false);

  // Resuming a specific application (?applicationId=…, e.g. a converted lead or
  // a "Continue" from My Drafts) OR a freshly started onboarding → the wizard.
  // Otherwise show the chooser card (New Dealer Onboarding / My Drafts).
  const showWizard = Boolean(applicationId) || startedNew;

  if (!showWizard) {
    return <OnboardingChooser onStartNew={() => setStartedNew(true)} />;
  }

  return (
    <>
      <OnboardingHydrator />
      <OnboardingLayout>
        {step === 1 && <StepCompany />}
        {step === 2 && <StepDocuments />}
        {step === 3 && <StepOwnership />}
        {step === 4 && <StepFinance />}
        {step === 5 && <StepAgreement />}
        {step === 6 && <StepReview />}
      </OnboardingLayout>
    </>
  );
}

export default function DealerOnboardingPage() {
  return (
    <Suspense fallback={null}>
      <OnboardingPageInner />
    </Suspense>
  );
}
