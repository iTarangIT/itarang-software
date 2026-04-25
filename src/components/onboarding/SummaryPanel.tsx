"use client";

import { useOnboardingStore } from "@/store/onboardingStore";

export default function SummaryPanel() {
  const step = useOnboardingStore((s) => s.step);
  const completion = Math.round(((step - 1) / 5) * 100);
  const companyName = useOnboardingStore((s) => s.company.companyName);
  const gst = useOnboardingStore((s) => s.company.gstNumber);
  const finance = useOnboardingStore((s) => s.finance.enableFinance);

  return (
    <div className="space-y-4 xl:sticky xl:top-6">
      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
        <h3 className="text-xl font-bold text-[#173F63] mb-3">Application Progress</h3>
        <div className="w-full h-3 rounded-full bg-slate-200 overflow-hidden">
          <div
            className="h-full bg-[#1F5C8F] transition-all duration-300"
            style={{ width: `${completion}%` }}
          />
        </div>
        <p className="mt-3 text-sm text-slate-500">{completion}% completed</p>
      </div>

      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
        <h3 className="text-xl font-bold text-[#173F63] mb-3">Company Snapshot</h3>
        <div className="space-y-2 text-sm text-slate-600">
          <p>Company: {companyName || "Not added"}</p>
          <p>GST: {gst || "Pending"}</p>
          <p>Finance Enablement: {finance === "yes" ? "Selected" : finance === "no" ? "Skipped" : "Not decided"}</p>
        </div>
      </div>

      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
        <h3 className="text-xl font-bold text-[#173F63] mb-3">Current Step</h3>
        <p className="text-sm text-slate-600">Step {step} of 6</p>
      </div>
    </div>
  );
}