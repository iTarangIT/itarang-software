"use client";

import FileUploadCard from "../FileUploadCard";
import { useOnboardingStore } from "@/store/onboardingStore";

export default function StepDocuments() {
  const compliance = useOnboardingStore((s) => s.compliance);
  const errors = useOnboardingStore((s) => s.errors);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const setUpload = useOnboardingStore((s) => s.setUpload);

  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-5 md:p-8 shadow-sm">
      <div className="mb-8">
        <h2 className="text-2xl md:text-3xl font-bold text-[#173F63]">
          Financial & Compliance Documents
        </h2>
        <p className="mt-2 max-w-3xl text-sm md:text-base text-slate-500">
          Upload the required business and compliance documents for dealer verification.
          Each file will show upload progress, file name, and verification status.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <FileUploadCard
          label="Last 3 Years Company Income Tax Returns (ITR)"
          hint="Accepted: PDF, JPG, PNG"
          value={compliance.itr3Years}
          onChange={(item) => setUpload("compliance.itr3Years", item)}
          error={errors.itr3Years}
        />

        <FileUploadCard
          label="Last 3 Months Company Bank Statement"
          hint="Accepted: PDF, JPG, PNG"
          value={compliance.bankStatement3Months}
          onChange={(item) => setUpload("compliance.bankStatement3Months", item)}
          error={errors.bankStatement3Months}
        />

        <FileUploadCard
          label="4 Undated Cheques"
          hint="Accepted: PDF, JPG, PNG"
          value={compliance.undatedCheques}
          onChange={(item) => setUpload("compliance.undatedCheques", item)}
          error={errors.undatedCheques}
        />

        <FileUploadCard
          label="Passport Size Photograph"
          hint="Accepted: JPG, PNG"
          value={compliance.passportPhoto}
          onChange={(item) => setUpload("compliance.passportPhoto", item)}
          error={errors.passportPhoto}
        />

        <div className="xl:col-span-2">
          <FileUploadCard
            label="Udyam Registration Certificate"
            hint="Accepted: PDF, JPG, PNG"
            value={compliance.udyamCertificate}
            onChange={(item) => setUpload("compliance.udyamCertificate", item)}
            error={errors.udyamCertificate}
          />
        </div>
      </div>

      <div className="mt-8 rounded-2xl border border-[#E3E8EF] bg-[#F9FBFD] p-4 md:p-5">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#173F63]">Document Checklist</h3>
            <p className="text-xs text-slate-500 mt-1">
              Make sure all uploads are clear, readable, and belong to the same dealer business.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 md:flex md:flex-wrap md:gap-3">
            <span className="rounded-full bg-white border border-[#E3E8EF] px-3 py-1.5">ITR</span>
            <span className="rounded-full bg-white border border-[#E3E8EF] px-3 py-1.5">Bank Statement</span>
            <span className="rounded-full bg-white border border-[#E3E8EF] px-3 py-1.5">Cheques</span>
            <span className="rounded-full bg-white border border-[#E3E8EF] px-3 py-1.5">Photo</span>
            <span className="rounded-full bg-white border border-[#E3E8EF] px-3 py-1.5">Udyam Certificate</span>
          </div>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={prevStep}
          className="inline-flex items-center justify-center rounded-2xl border border-[#E3E8EF] px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          ← Back
        </button>

        <button
          type="button"
          onClick={nextStep}
          className="inline-flex items-center justify-center rounded-2xl bg-[#1F5C8F] px-6 py-3 text-sm font-semibold text-white hover:bg-[#173F63]"
        >
          Next →
        </button>
      </div>
    </div>
  );
}