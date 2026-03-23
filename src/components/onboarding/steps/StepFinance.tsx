"use client";

import { useOnboardingStore } from "@/store/onboardingStore";

export default function StepFinance() {
  const finance = useOnboardingStore((s) => s.finance);
  const errors = useOnboardingStore((s) => s.errors);

  const setField = useOnboardingStore((s) => s.setField);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);

  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 md:p-8 shadow-sm space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-[#173F63]">
          Finance Enablement Preference
        </h2>
        <p className="mt-1 text-slate-500">
          Choose whether you want to enable finance for this dealer.
        </p>
      </div>

      {/* YES / NO CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <button
          type="button"
          onClick={() => setField("finance", "enableFinance", "yes")}
          className={`rounded-2xl border p-6 text-left transition ${
            finance.enableFinance === "yes"
              ? "border-[#1F5C8F] bg-blue-50"
              : "border-[#E3E8EF] hover:border-[#1F5C8F]/40"
          }`}
        >
          <p className="font-semibold text-[#173F63] text-lg">
            Yes, enable finance
          </p>
          <p className="text-sm text-slate-500 mt-1">
            Dealer agreement step will be required.
          </p>
        </button>

        <button
          type="button"
          onClick={() => setField("finance", "enableFinance", "no")}
          className={`rounded-2xl border p-6 text-left transition ${
            finance.enableFinance === "no"
              ? "border-[#1F5C8F] bg-blue-50"
              : "border-[#E3E8EF] hover:border-[#1F5C8F]/40"
          }`}
        >
          <p className="font-semibold text-[#173F63] text-lg">
            No, continue without finance
          </p>
          <p className="text-sm text-slate-500 mt-1">
            Agreement step will be skipped.
          </p>
        </button>
      </div>

      {/* ERROR */}
      {errors.enableFinance && (
        <p className="text-sm text-red-600">{errors.enableFinance}</p>
      )}

      {/* NAVIGATION */}
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
          onClick={nextStep}
          className="px-6 py-3 rounded-2xl bg-[#1F5C8F] text-white font-semibold hover:bg-[#173F63]"
        >
          Next →
        </button>
      </div>
    </div>
  );
}