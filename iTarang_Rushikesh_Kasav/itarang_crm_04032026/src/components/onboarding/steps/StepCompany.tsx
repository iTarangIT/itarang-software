"use client";

import FileUploadCard from "../FileUploadCard";
import { useOnboardingStore } from "@/store/onboardingStore";

export default function StepCompany() {
  const company = useOnboardingStore((s) => s.company);
  const errors = useOnboardingStore((s) => s.errors);
  const setField = useOnboardingStore((s) => s.setField);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const setUpload = useOnboardingStore((s) => s.setUpload);

  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 md:p-8 shadow-sm">
      <h2 className="text-2xl font-bold text-[#173F63] mb-8">Business Details</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <input
            value={company.companyName}
            onChange={(e) => setField("company", "companyName", e.target.value)}
            placeholder="Company Name"
            className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
          />
          {errors.companyName && <p className="text-sm text-red-600 mt-2">{errors.companyName}</p>}
        </div>

        <div>
          <select
            value={company.companyType}
            onChange={(e) => setField("company", "companyType", e.target.value)}
            className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
          >
            <option value="">Company Type</option>
            <option value="sole_proprietorship">Sole Proprietorship</option>
            <option value="partnership_firm">Partnership Firm</option>
            <option value="private_limited_firm">Private Limited Firm</option>
          </select>
          {errors.companyType && <p className="text-sm text-red-600 mt-2">{errors.companyType}</p>}
        </div>
      </div>

      <div className="mt-6">
        <input
          value={company.companyAddress}
          onChange={(e) => setField("company", "companyAddress", e.target.value)}
          placeholder="Company Address"
          className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
        />
        {errors.companyAddress && <p className="text-sm text-red-600 mt-2">{errors.companyAddress}</p>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
        <div>
          <input
            value={company.gstNumber}
            onChange={(e) => setField("company", "gstNumber", e.target.value.toUpperCase())}
            placeholder="GST Number"
            className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 uppercase focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
          />
          {errors.gstNumber && <p className="text-sm text-red-600 mt-2">{errors.gstNumber}</p>}
        </div>

        <div>
          <input
            value={company.companyPanNumber}
            onChange={(e) => setField("company", "companyPanNumber", e.target.value.toUpperCase())}
            placeholder="Company PAN Number"
            className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-4 uppercase focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
          />
          {errors.companyPanNumber && <p className="text-sm text-red-600 mt-2">{errors.companyPanNumber}</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
        <div>
          <FileUploadCard
            label="Upload GST Certificate"
            hint="Accepted: JPG, PNG, PDF"
            value={(useOnboardingStore.getState() as any).company.gstCertificate}
            onChange={(item) => setUpload("company.gstCertificate", item)}
          />
        </div>

        <div>
          <FileUploadCard
            label="Upload Company PAN"
            hint="Accepted: JPG, PNG, PDF"
            value={(useOnboardingStore.getState() as any).company.companyPanFile}
            onChange={(item) => setUpload("company.companyPanFile", item)}
          />
        </div>
      </div>

      <div className="flex justify-end mt-8">
        <button
          type="button"
          onClick={nextStep}
          className="px-6 py-3 rounded-2xl bg-[#1F5C8F] text-white font-semibold hover:bg-[#173F63] transition"
        >
          Next →
        </button>
      </div>
    </div>
  );
}