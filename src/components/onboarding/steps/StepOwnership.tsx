"use client";

import FileUploadCard from "../FileUploadCard";
import { useOnboardingStore } from "@/store/onboardingStore";

type ContactRow = {
  id: string;
  name: string;
  phone: string;
  landline?: string; // optional
  email: string;
  age?: string;
  photo?: any;
  addressLine1?: string;
  city?: string;
  district?: string;
  state?: string;
  pinCode?: string;
};

function TextInput({
  value,
  onChange,
  placeholder,
  className = "",
}: {
  value?: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <input
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-xl border border-[#E3E8EF] px-4 py-3 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100 ${className}`}
    />
  );
}

function ContactDetailCard({
  title,
  rows,
  update,
  remove,
  uploadPathPrefix,
}: {
  title: string;
  rows: ContactRow[];
  update: (id: string, field: string, value: string) => void;
  remove: (id: string) => void;
  uploadPathPrefix: "ownership.partners" | "ownership.directors";
}) {
  return (
    <div className="space-y-5">
      {rows.map((row, index) => (
        <div
          key={row.id}
          className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-5"
        >
          <div className="mb-4 flex items-center justify-between">
            <h4 className="font-semibold text-[#173F63]">
              {title} {index + 1}
            </h4>
            {rows.length > 1 ? (
              <button
                type="button"
                onClick={() => remove(row.id)}
                className="text-sm font-medium text-red-600"
              >
                Remove
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TextInput
              value={row.name}
              onChange={(value) =>
                update(row.id, "name", value.replace(/[0-9]/g, ""))
              }
              placeholder={`${title} Name`}
            />

            <TextInput
              value={row.phone}
              onChange={(value) =>
                update(
                  row.id,
                  "phone",
                  value.replace(/[^0-9]/g, "").slice(0, 10)
                )
              }
              placeholder={`${title} Phone Number`}
            />

            {/* Landline Number — optional */}
            <TextInput
              value={row.landline || ""}
              onChange={(value) =>
                update(row.id, "landline", value.replace(/[^0-9]/g, ""))
              }
              placeholder={`${title} Landline Number (Optional)`}
            />

            <TextInput
              value={row.email}
              onChange={(value) => update(row.id, "email", value)}
              placeholder={`${title} Email ID`}
            />

            <TextInput
              value={row.age || ""}
              onChange={(value) =>
                update(
                  row.id,
                  "age",
                  value.replace(/[^0-9]/g, "").slice(0, 2)
                )
              }
              placeholder={`${title} Age`}
            />
          </div>

          <div className="mt-5">
            <FileUploadCard
              label={`${title} Photograph`}
              hint="Drag image or click to upload"
              value={(row as any).photo || null}
              onChange={(item) => update(row.id, "photo", item as any)}
            />
          </div>

          <div className="mt-5">
            <p className="mb-3 text-sm font-semibold text-[#173F63]">
              {title} Residential Address
            </p>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <TextInput
                  value={row.addressLine1 || ""}
                  onChange={(value) => update(row.id, "addressLine1", value)}
                  placeholder="Address Line 1"
                />
              </div>

              <TextInput
                value={row.city || ""}
                onChange={(value) =>
                  update(row.id, "city", value.replace(/[^a-zA-Z\s]/g, ""))
                }
                placeholder="City"
              />

              <TextInput
                value={row.district || ""}
                onChange={(value) =>
                  update(row.id, "district", value.replace(/[^a-zA-Z\s]/g, ""))
                }
                placeholder="District"
              />

              <TextInput
                value={row.state || ""}
                onChange={(value) =>
                  update(row.id, "state", value.replace(/[^a-zA-Z\s]/g, ""))
                }
                placeholder="State"
              />

              <TextInput
                value={row.pinCode || ""}
                onChange={(value) =>
                  update(row.id, "pinCode", value.replace(/[^0-9]/g, ""))
                }
                placeholder="Pin Code"
              />
            </div>
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

  const partners = (ownership.partners || []) as ContactRow[];
  const directors = (ownership.directors || []) as ContactRow[];

  return (
    <div className="space-y-8 rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm md:p-8">
      <div>
        <h2 className="text-2xl font-bold text-[#173F63]">
          Ownership & Banking Details
        </h2>
        <p className="mt-1 text-slate-500">
          This section changes dynamically based on the selected company type.
        </p>
      </div>

      {companyType === "sole_proprietorship" && (
        <div className="space-y-6">
          <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-5">
            <h3 className="mb-4 text-lg font-semibold text-[#173F63]">
              Owner Details
            </h3>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <TextInput
                value={ownership.ownerName}
                onChange={(value) =>
                  setField(
                    "ownership",
                    "ownerName",
                    value.replace(/[0-9]/g, "")
                  )
                }
                placeholder="Owner Name"
              />

              <TextInput
                value={ownership.ownerPhone}
                onChange={(value) =>
                  setField(
                    "ownership",
                    "ownerPhone",
                    value.replace(/[^0-9]/g, "").slice(0, 10)
                  )
                }
                placeholder="Owner Phone Number"
              />

              {/* Landline — optional */}
              <TextInput
                value={ownership.ownerLandline || ""}
                onChange={(value) =>
                  setField(
                    "ownership",
                    "ownerLandline",
                    value.replace(/[^0-9]/g, "")
                  )
                }
                placeholder="Owner Landline Number (Optional)"
              />

              <TextInput
                value={ownership.ownerEmail}
                onChange={(value) => setField("ownership", "ownerEmail", value)}
                placeholder="Owner Email ID"
              />

              <TextInput
                value={(ownership as any).ownerAge || ""}
                onChange={(value) =>
                  setField(
                    "ownership",
                    "ownerAge",
                    value.replace(/[^0-9]/g, "").slice(0, 2)
                  )
                }
                placeholder="Owner Age"
              />
            </div>

            <div className="mt-5">
              <FileUploadCard
                label="Owner Photograph"
                hint="Drag image or click to upload"
                value={(ownership as any).ownerPhoto || null}
                onChange={(item) => setUpload("ownership.ownerPhoto", item)}
              />
            </div>

            <div className="mt-5">
              <p className="mb-3 text-sm font-semibold text-[#173F63]">
                Owner Residential Address
              </p>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <TextInput
                    value={(ownership as any).ownerAddressLine1 || ""}
                    onChange={(value) =>
                      setField("ownership", "ownerAddressLine1", value)
                    }
                    placeholder="Address Line 1"
                  />
                </div>

                <TextInput
                  value={(ownership as any).ownerCity || ""}
                  onChange={(value) =>
                    setField(
                      "ownership",
                      "ownerCity",
                      value.replace(/[^a-zA-Z\s]/g, "")
                    )
                  }
                  placeholder="City"
                />

                <TextInput
                  value={(ownership as any).ownerDistrict || ""}
                  onChange={(value) =>
                    setField(
                      "ownership",
                      "ownerDistrict",
                      value.replace(/[^a-zA-Z\s]/g, "")
                    )
                  }
                  placeholder="District"
                />

                <TextInput
                  value={(ownership as any).ownerState || ""}
                  onChange={(value) =>
                    setField(
                      "ownership",
                      "ownerState",
                      value.replace(/[^a-zA-Z\s]/g, "")
                    )
                  }
                  placeholder="State"
                />

                <TextInput
                  value={(ownership as any).ownerPinCode || ""}
                  onChange={(value) =>
                    setField(
                      "ownership",
                      "ownerPinCode",
                      value.replace(/[^0-9]/g, "")
                    )
                  }
                  placeholder="Pin Code"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {companyType === "partnership_firm" && (
        <>
          <FileUploadCard
            label="Upload Partnership Deed Copy"
            hint="Drag file or click to upload"
            value={ownership.partnershipDeed}
            onChange={(item) => setUpload("ownership.partnershipDeed", item)}
          />

          <div className="flex items-center justify-between">
            <h3 className="text-xl font-semibold text-[#173F63]">
              Partner Details
            </h3>
            <button
              type="button"
              onClick={addPartner}
              className="rounded-xl border border-[#E3E8EF] px-4 py-2 font-semibold text-[#1F5C8F]"
            >
              + Add Another Partner
            </button>
          </div>

          <ContactDetailCard
            title="Partner"
            rows={partners}
            update={updatePartner}
            remove={removePartner}
            uploadPathPrefix="ownership.partners"
          />
        </>
      )}

      {companyType === "private_limited_firm" && (
        <>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <FileUploadCard
              label="MoU (Memorandum of Understanding)"
              hint="Drag file or click to upload"
              value={ownership.mouDocument}
              onChange={(item) => setUpload("ownership.mouDocument", item)}
            />
            <FileUploadCard
              label="AoA (Articles of Association)"
              hint="Drag file or click to upload"
              value={ownership.aoaDocument}
              onChange={(item) => setUpload("ownership.aoaDocument", item)}
            />
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-xl font-semibold text-[#173F63]">
              Director Details
            </h3>
            <button
              type="button"
              onClick={addDirector}
              className="rounded-xl border border-[#E3E8EF] px-4 py-2 font-semibold text-[#1F5C8F]"
            >
              + Add Director
            </button>
          </div>

          <ContactDetailCard
            title="Director"
            rows={directors}
            update={updateDirector}
            remove={removeDirector}
            uploadPathPrefix="ownership.directors"
          />
        </>
      )}

      <div>
        <h3 className="mb-4 text-xl font-semibold text-[#173F63]">
          Bank Account Information
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextInput
            value={ownership.bankName}
            onChange={(value) =>
              setField(
                "ownership",
                "bankName",
                value.replace(/[^a-zA-Z\s]/g, "")
              )
            }
            placeholder="Bank Name"
          />

          <TextInput
            value={ownership.accountNumber}
            onChange={(value) =>
              setField(
                "ownership",
                "accountNumber",
                value.replace(/[^0-9]/g, "")
              )
            }
            placeholder="Account Number"
          />

          <TextInput
            value={ownership.ifsc}
            onChange={(value) =>
              setField(
                "ownership",
                "ifsc",
                value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11)
              )
            }
            placeholder="IFSC"
            className="uppercase"
          />

          <TextInput
            value={ownership.beneficiaryName}
            onChange={(value) =>
              setField(
                "ownership",
                "beneficiaryName",
                value.replace(/[^a-zA-Z0-9\s]/g, "")
              )
            }
            placeholder="Beneficiary Name"
          />

          <TextInput
            value={(ownership as any).branch || ""}
            onChange={(value) =>
              setField(
                "ownership",
                "branch",
                value.replace(/[^a-zA-Z0-9\s]/g, "")
              )
            }
            placeholder="Branch"
          />

          <select
            value={(ownership as any).accountType || ""}
            onChange={(e) =>
              setField("ownership", "accountType", e.target.value)
            }
            className="w-full rounded-xl border border-[#E3E8EF] bg-white px-4 py-3 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            <option value="">Account Type</option>
            <option value="current">Current</option>
            <option value="savings">Savings</option>
            <option value="od">OD</option>
          </select>
        </div>
      </div>

      {Object.values(errors).length > 0 && (
        <div className="space-y-2">
          {Object.values(errors).map((error, index) => (
            <p key={index} className="text-sm text-red-600">
              {String(error)}
            </p>
          ))}
        </div>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={prevStep}
          className="rounded-2xl border border-[#E3E8EF] px-6 py-3 font-semibold text-slate-700"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={nextStep}
          className="rounded-2xl bg-[#1F5C8F] px-6 py-3 font-semibold text-white hover:bg-[#173F63]"
        >
          Next →
        </button>
      </div>
    </div>
  );
}