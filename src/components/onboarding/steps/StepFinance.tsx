"use client";

import { useOnboardingStore } from "@/store/onboardingStore";

export default function StepFinance() {
  const finance = useOnboardingStore((s) => s.finance);
  const agreement = useOnboardingStore((s) => s.agreement);
  const errors = useOnboardingStore((s) => s.errors);

  const setField = useOnboardingStore((s) => s.setField);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);

  const labelCls = "mb-1.5 block text-sm font-semibold text-[#173F63]";
  const requiredMark = <span className="ml-0.5 text-red-500">*</span>;
  const inputCls =
    "w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100";

  const updateSalesManager = (patch: Partial<{ name: string; email: string; mobile: string; age: string }>) =>
    setField("agreement", "salesManager", {
      ...(agreement.salesManager || { name: "", email: "", mobile: "" }),
      ...patch,
    });

  const sm = (agreement.salesManager || {}) as {
    name?: string;
    email?: string;
    mobile?: string;
    age?: string;
  };

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
            Agreement step will be skipped. Sales manager details are captured below.
          </p>
        </button>
      </div>

      {/* ERROR */}
      {errors.enableFinance && (
        <p className="text-sm text-red-600">{errors.enableFinance}</p>
      )}

      {/* SALES MANAGER — only when finance disabled */}
      {finance.enableFinance === "no" && (
        <section className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-5 md:p-6 space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-[#173F63]">
              Sales Manager Information
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Details of the sales manager handling this dealer relationship.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label htmlFor="smName" className={labelCls}>
                Sales Manager Name{requiredMark}
              </label>
              <input
                id="smName"
                value={sm.name || ""}
                onChange={(e) =>
                  updateSalesManager({
                    name: e.target.value.replace(/[0-9]/g, ""),
                  })
                }
                placeholder="Full name"
                className={inputCls}
              />
              {errors.salesManager_name ? (
                <p className="mt-1.5 text-sm text-red-600">{errors.salesManager_name}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="smEmail" className={labelCls}>
                Sales Manager Email{requiredMark}
              </label>
              <input
                id="smEmail"
                type="email"
                value={sm.email || ""}
                onChange={(e) => updateSalesManager({ email: e.target.value })}
                placeholder="name@example.com"
                className={inputCls}
              />
              {errors.salesManager_email ? (
                <p className="mt-1.5 text-sm text-red-600">{errors.salesManager_email}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="smMobile" className={labelCls}>
                Sales Manager Contact Number{requiredMark}
              </label>
              <input
                id="smMobile"
                value={sm.mobile || ""}
                onChange={(e) =>
                  updateSalesManager({
                    mobile: e.target.value.replace(/[^0-9]/g, "").slice(0, 10),
                  })
                }
                placeholder="10-digit mobile number"
                className={inputCls}
              />
              {errors.salesManager_mobile ? (
                <p className="mt-1.5 text-sm text-red-600">{errors.salesManager_mobile}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="smAge" className={labelCls}>
                Sales Manager Age{requiredMark}
              </label>
              <input
                id="smAge"
                value={sm.age || ""}
                onChange={(e) =>
                  updateSalesManager({
                    age: e.target.value.replace(/[^0-9]/g, "").slice(0, 2),
                  })
                }
                placeholder="Age (18 – 90)"
                className={inputCls}
              />
              {errors.salesManager_age ? (
                <p className="mt-1.5 text-sm text-red-600">{errors.salesManager_age}</p>
              ) : null}
            </div>
          </div>
        </section>
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