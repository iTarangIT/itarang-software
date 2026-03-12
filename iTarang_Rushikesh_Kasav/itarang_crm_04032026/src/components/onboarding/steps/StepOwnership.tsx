"use client";

import FileUploadCard from "../FileUploadCard";
import { useOnboardingStore } from "@/store/onboardingStore";

function ContactInputCard({
  title,
  rows,
  update,
  remove,
}: {
  title: string;
  rows: { id: string; name: string; phone: string; email: string }[];
  update: (id: string, field: "name" | "phone" | "email", value: string) => void;
  remove: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      {rows.map((row, index) => (
        <div key={row.id} className="rounded-2xl border border-[#E3E8EF] p-4 bg-[#FBFDFF]">
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-semibold text-[#173F63]">{title} {index + 1}</h4>
            <button
              type="button"
              onClick={() => remove(row.id)}
              className="text-sm text-red-600 font-medium"
            >
              Remove
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              value={row.name}
              onChange={(e) => update(row.id, "name", e.target.value)}
              placeholder={`${title} Name`}
              className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
            />
            <input
              value={row.phone}
              onChange={(e) => update(row.id, "phone", e.target.value)}
              placeholder={`${title} Phone Number`}
              className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
            />
            <input
              value={row.email}
              onChange={(e) => update(row.id, "email", e.target.value)}
              placeholder={`${title} Email ID`}
              className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function StepOwnership() {
  const companyType = useOnboardingStore((s) => s.company.companyType);
  const ownership = useOnboardingStore((s) => s.ownership);
  const errors = useOnboardingStore((s) => s.errors);

  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const setField = useOnboardingStore((s) => s.setField);
  const setUpload = useOnboardingStore((s) => s.setUpload);
  const addPartner = useOnboardingStore((s) => s.addPartner);
  const updatePartner = useOnboardingStore((s) => s.updatePartner);
  const removePartner = useOnboardingStore((s) => s.removePartner);
  const addDirector = useOnboardingStore((s) => s.addDirector);
  const updateDirector = useOnboardingStore((s) => s.updateDirector);
  const removeDirector = useOnboardingStore((s) => s.removeDirector);

  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 md:p-8 shadow-sm space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-[#173F63]">Ownership & Banking Details</h2>
        <p className="text-slate-500 mt-1">
          This section changes based on the selected company type.
        </p>
      </div>

      {companyType === "sole_proprietorship" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            value={ownership.ownerName}
            onChange={(e) => setField("ownership", "ownerName", e.target.value)}
            placeholder="Owner Name"
            className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
          />
          <input
            value={ownership.ownerPhone}
            onChange={(e) => setField("ownership", "ownerPhone", e.target.value)}
            placeholder="Owner Phone Number"
            className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
          />
          <input
            value={ownership.ownerEmail}
            onChange={(e) => setField("ownership", "ownerEmail", e.target.value)}
            placeholder="Owner Email ID"
            className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
          />
        </div>
      )}

      {companyType === "partnership_firm" && (
        <>
          <FileUploadCard
            label="Upload Partnership Deed Copy"
            hint="PDF preferred"
            value={ownership.partnershipDeed}
            onChange={(item) => setUpload("ownership.partnershipDeed", item)}
          />

          <div className="flex items-center justify-between">
            <h3 className="text-xl font-semibold text-[#173F63]">Partner Details</h3>
            <button
              type="button"
              onClick={addPartner}
              className="px-4 py-2 rounded-xl border border-[#E3E8EF] text-[#1F5C8F] font-semibold"
            >
              + Add Another Partner
            </button>
          </div>

          <ContactInputCard
            title="Partner"
            rows={ownership.partners}
            update={updatePartner}
            remove={removePartner}
          />
        </>
      )}

      {companyType === "private_limited_firm" && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <FileUploadCard
              label="Upload MoU (Memorandum of Understanding)"
              hint="PDF preferred"
              value={ownership.mouDocument}
              onChange={(item) => setUpload("ownership.mouDocument", item)}
            />
            <FileUploadCard
              label="Upload AoA (Articles of Association)"
              hint="PDF preferred"
              value={ownership.aoaDocument}
              onChange={(item) => setUpload("ownership.aoaDocument", item)}
            />
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-xl font-semibold text-[#173F63]">Director Details</h3>
            <button
              type="button"
              onClick={addDirector}
              className="px-4 py-2 rounded-xl border border-[#E3E8EF] text-[#1F5C8F] font-semibold"
            >
              + Add Director
            </button>
          </div>

          <ContactInputCard
            title="Director"
            rows={ownership.directors}
            update={updateDirector}
            remove={removeDirector}
          />
        </>
      )}

      <div>
        <h3 className="text-xl font-semibold text-[#173F63] mb-4">Bank Account Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input
            value={ownership.bankName}
            onChange={(e) => setField("ownership", "bankName", e.target.value)}
            placeholder="Bank Name"
            className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
          />
          <input
            value={ownership.accountNumber}
            onChange={(e) => setField("ownership", "accountNumber", e.target.value)}
            placeholder="Account Number"
            className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
          />
          <input
            value={ownership.ifsc}
            onChange={(e) => setField("ownership", "ifsc", e.target.value.toUpperCase())}
            placeholder="IFSC"
            className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3 uppercase"
          />
          <input
            value={ownership.beneficiaryName}
            onChange={(e) => setField("ownership", "beneficiaryName", e.target.value)}
            placeholder="Beneficiary Name"
            className="w-full rounded-xl border border-[#E3E8EF] px-4 py-3"
          />
        </div>
      </div>

      {Object.values(errors).length > 0 && (
        <div className="space-y-2">
          {Object.values(errors).map((error, index) => (
            <p key={index} className="text-sm text-red-600">{error}</p>
          ))}
        </div>
      )}

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