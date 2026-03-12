"use client";

import { useOnboardingStore } from "@/store/onboardingStore";

export default function StepFinance() {
  const finance = useOnboardingStore((s) => s.finance);
  const errors = useOnboardingStore((s) => s.errors);
  const setField = useOnboardingStore((s) => s.setField);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);

  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 md:p-8 shadow-sm">
      <h2 className="text-2xl font-bold text-[#173F63] mb-2">Finance Enablement Preference</h2>
      <p className="text-slate-500 mb-8">
        Finance-enabled dealers can process eligible dealer workflows through iTarang CRM and may be required to sign a dealer finance agreement.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <button
          type="button"
          onClick={() => setField("finance", "enableFinance", "yes")}
          className={`rounded-2xl border p-6 text-left ${
            finance.enableFinance === "yes"
              ? "border-[#1F5C8F] bg-blue-50"
              : "border-[#E3E8EF] bg-white"
          }`}
        >
          <h3 className="text-lg font-semibold text-[#173F63]">Yes, enable finance</h3>
          <p className="text-sm text-slate-500 mt-1">
            Dealer agreement step will become required.
          </p>
        </button>

        <button
          type="button"
          onClick={() => setField("finance", "enableFinance", "no")}
          className={`rounded-2xl border p-6 text-left ${
            finance.enableFinance === "no"
              ? "border-[#1F5C8F] bg-blue-50"
              : "border-[#E3E8EF] bg-white"
          }`}
        >
          <h3 className="text-lg font-semibold text-[#173F63]">No, continue without finance</h3>
          <p className="text-sm text-slate-500 mt-1">
            Dealer Agreement step will be skipped and you will move to Review & Submit.
          </p>
        </button>
      </div>

      {errors.enableFinance && <p className="text-sm text-red-600 mt-4">{errors.enableFinance}</p>}

      {finance.enableFinance === "yes" && (
        <div className="mt-8 rounded-2xl border border-[#E3E8EF] p-6 bg-[#FBFDFF]">
          <h3 className="text-lg font-semibold text-[#173F63] mb-4">Finance Contact Details</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input
              value={finance.financeContactPerson}
              onChange={(e) => setField("finance", "financeContactPerson", e.target.value)}
              placeholder="Preferred finance contact person"
              className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
            />
            <input
              value={finance.financeContactPhone}
              onChange={(e) => setField("finance", "financeContactPhone", e.target.value)}
              placeholder="Finance contact phone number"
              className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
            />
            <input
              value={finance.financeContactEmail}
              onChange={(e) => setField("finance", "financeContactEmail", e.target.value)}
              placeholder="Finance contact email"
              className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3 md:col-span-2"
            />
            <textarea
              value={finance.financeRemarks}
              onChange={(e) => setField("finance", "financeRemarks", e.target.value)}
              placeholder="Optional remarks"
              className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3 md:col-span-2 min-h-[120px]"
            />
          </div>
        </div>
      )}

      <div className="flex justify-between mt-8">
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