"use client";

import { useOnboardingStore } from "@/store/onboardingStore";

const steps = [
  "Company Information",
  "Compliance Documents",
  "Ownership Details",
  "Finance Enablement",
  "Dealer Agreement",
  "Review & Submit",
];

export default function ProgressStepper() {
  const currentStep = useOnboardingStore((s) => s.step);
  const completion = Math.round(((currentStep - 1) / 5) * 100);

  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
      <p className="text-base text-slate-600 mb-5">Completion: {completion}%</p>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-5">
        {steps.map((step, index) => {
          const stepNo = index + 1;
          const active = stepNo === currentStep;
          const completed = stepNo < currentStep;

          return (
            <div key={step} className="flex flex-col items-center text-center">
              <div
                className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold ${
                  active || completed
                    ? "bg-[#1F5C8F] text-white"
                    : "bg-slate-200 text-slate-500"
                }`}
              >
                {stepNo}
              </div>
              <p className="text-sm text-slate-700 mt-3">{step}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}