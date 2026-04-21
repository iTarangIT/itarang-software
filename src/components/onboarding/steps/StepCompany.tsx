"use client";

import FileUploadCard from "../FileUploadCard";
import { useOnboardingStore } from "@/store/onboardingStore";

export default function StepCompany() {
  const company = useOnboardingStore((s) => s.company);
  const errors = useOnboardingStore((s) => s.errors);
  const setField = useOnboardingStore((s) => s.setField);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const setUpload = useOnboardingStore((s) => s.setUpload);

  const labelCls = "mb-2 block text-sm font-semibold text-[#173F63]";
  const requiredMark = <span className="ml-0.5 text-red-500">*</span>;

  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm md:p-8">
      <h2 className="mb-8 text-2xl font-bold text-[#173F63]">Business Details</h2>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <label htmlFor="companyName" className={labelCls}>
            Company Name{requiredMark}
          </label>
          <input
            id="companyName"
            value={company.companyName}
            onChange={(e) =>
              setField(
                "company",
                "companyName",
                e.target.value.replace(/[0-9]/g, "")
              )
            }
            placeholder="e.g. iTarang Pvt Ltd"
            className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          {errors.companyName && (
            <p className="mt-2 text-sm text-red-600">{errors.companyName}</p>
          )}
        </div>

        <div>
          <label htmlFor="companyType" className={labelCls}>
            Company Type{requiredMark}
          </label>
          <select
            id="companyType"
            value={company.companyType}
            onChange={(e) => setField("company", "companyType", e.target.value)}
            className="w-full rounded-2xl border border-[#E3E8EF] bg-white px-4 py-4 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            <option value="">Select company type</option>
            <option value="sole_proprietorship">Sole Proprietorship</option>
            <option value="partnership_firm">Partnership Firm</option>
            <option value="private_limited_firm">Private Limited Firm</option>
          </select>
          {errors.companyType && (
            <p className="mt-2 text-sm text-red-600">{errors.companyType}</p>
          )}
        </div>
      </div>

      <div className="mt-6">
        <label htmlFor="companyAddress" className={labelCls}>
          Company Address{requiredMark}
        </label>
        <input
          id="companyAddress"
          value={company.companyAddress}
          onChange={(e) => setField("company", "companyAddress", e.target.value)}
          placeholder="Registered address of the company"
          className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
        {errors.companyAddress && (
          <p className="mt-2 text-sm text-red-600">{errors.companyAddress}</p>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <label htmlFor="gstNumber" className={labelCls}>
            GST Number{requiredMark}
          </label>
          <input
            id="gstNumber"
            value={company.gstNumber}
            onChange={(e) =>
              setField("company", "gstNumber", e.target.value.toUpperCase())
            }
            placeholder="15-digit GSTIN"
            className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 uppercase focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          {errors.gstNumber && (
            <p className="mt-2 text-sm text-red-600">{errors.gstNumber}</p>
          )}
        </div>

        <div>
          <label htmlFor="companyPanNumber" className={labelCls}>
            Company PAN Number{requiredMark}
          </label>
          <input
            id="companyPanNumber"
            value={company.companyPanNumber}
            onChange={(e) =>
              setField("company", "companyPanNumber", e.target.value.toUpperCase())
            }
            placeholder="10-character PAN"
            className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 uppercase focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          {errors.companyPanNumber && (
            <p className="mt-2 text-sm text-red-600">{errors.companyPanNumber}</p>
          )}
        </div>
      </div>

      <div className="mt-6">
        <label htmlFor="businessSummary" className={labelCls}>
          Business Details — Summary{requiredMark}
        </label>
        <textarea
          id="businessSummary"
          value={(company as any).businessSummary || ""}
          onChange={(e) =>
            setField("company", "businessSummary", e.target.value)
          }
          placeholder="Short description of the business, operations, products, etc."
          rows={5}
          className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
        {(errors as any).businessSummary && (
          <p className="mt-2 text-sm text-red-600">
            {(errors as any).businessSummary}
          </p>
        )}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <FileUploadCard
            label="Upload GST Certificate"
            hint="Drag file or click to upload"
            value={(company as any).gstCertificate}
            onChange={(item) => setUpload("company.gstCertificate", item)}
            error={errors.gstCertificate}
          />
        </div>

        <div>
          <FileUploadCard
            label="Upload Company PAN"
            hint="Drag file or click to upload"
            value={(company as any).companyPanFile}
            onChange={(item) => setUpload("company.companyPanFile", item)}
            error={errors.companyPanFile}
          />
        </div>
      </div>

      <div className="mt-8 flex justify-end">
        <button
          type="button"
          onClick={nextStep}
          className="rounded-2xl bg-[#1F5C8F] px-6 py-3 font-semibold text-white transition hover:bg-[#173F63]"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
