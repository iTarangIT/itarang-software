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
  label,
  value,
  onChange,
  placeholder,
  className = "",
  error,
  required,
}: {
  label?: string;
  value?: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
  error?: string;
  required?: boolean;
}) {
  return (
    <div>
      {label ? (
        <label className="mb-1.5 block text-sm font-semibold text-[#173F63]">
          {label}
          {required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </label>
      ) : null}
      <input
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-xl border border-[#E3E8EF] px-4 py-3 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100 ${className}`}
      />
      {error ? <p className="mt-1.5 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

function ContactDetailCard({
  title,
  rows,
  update,
  remove,
  uploadPathPrefix,
  errors,
}: {
  title: string;
  rows: ContactRow[];
  update: (id: string, field: string, value: string) => void;
  remove: (id: string) => void;
  uploadPathPrefix: "ownership.partners" | "ownership.directors";
  errors: Record<string, string>;
}) {
  // Error keys are emitted as `partner_<field>_<index>` / `director_<field>_<index>`.
  const errKey = uploadPathPrefix === "ownership.partners" ? "partner" : "director";
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
              label={`${title} Name`}
              required
              value={row.name}
              onChange={(value) =>
                update(row.id, "name", value.replace(/[0-9]/g, ""))
              }
              placeholder={`Enter ${title.toLowerCase()}'s full name`}
              error={errors[`${errKey}_name_${index}`]}
            />

            <TextInput
              label={`${title} Phone Number`}
              required
              value={row.phone}
              onChange={(value) =>
                update(
                  row.id,
                  "phone",
                  value.replace(/[^0-9]/g, "").slice(0, 10)
                )
              }
              placeholder="10-digit mobile number"
              error={errors[`${errKey}_phone_${index}`]}
            />

            {/* Landline Number — optional */}
            <TextInput
              label={`${title} Landline Number`}
              value={row.landline || ""}
              onChange={(value) =>
                update(row.id, "landline", value.replace(/[^0-9]/g, ""))
              }
              placeholder="Landline (optional)"
            />

            <TextInput
              label={`${title} Email ID`}
              required
              value={row.email}
              onChange={(value) => update(row.id, "email", value)}
              placeholder="name@example.com"
              error={errors[`${errKey}_email_${index}`]}
            />

            <TextInput
              label={`${title} Age`}
              required
              value={row.age || ""}
              onChange={(value) =>
                update(
                  row.id,
                  "age",
                  value.replace(/[^0-9]/g, "").slice(0, 2)
                )
              }
              placeholder="Age (18 – 90)"
              error={errors[`${errKey}_age_${index}`]}
            />
          </div>

          <div className="mt-5">
            <FileUploadCard
              label={`${title} Photograph`}
              hint="Drag image or click to upload"
              value={(row as any).photo || null}
              onChange={(item) => update(row.id, "photo", item as any)}
              error={errors[`${errKey}_photo_${index}`]}
            />
          </div>

          <div className="mt-5">
            <p className="mb-3 text-sm font-semibold text-[#173F63]">
              {title} Residential Address
            </p>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <TextInput
                  label="Address Line 1"
                  required
                  value={row.addressLine1 || ""}
                  onChange={(value) => update(row.id, "addressLine1", value)}
                  placeholder="House / Street / Area"
                  error={errors[`${errKey}_addressLine1_${index}`]}
                />
              </div>

              <TextInput
                label="City"
                required
                value={row.city || ""}
                onChange={(value) =>
                  update(row.id, "city", value.replace(/[^a-zA-Z\s]/g, ""))
                }
                placeholder="City"
                error={errors[`${errKey}_city_${index}`]}
              />

              <TextInput
                label="District"
                required
                value={row.district || ""}
                onChange={(value) =>
                  update(row.id, "district", value.replace(/[^a-zA-Z\s]/g, ""))
                }
                placeholder="District"
                error={errors[`${errKey}_district_${index}`]}
              />

              <TextInput
                label="State"
                required
                value={row.state || ""}
                onChange={(value) =>
                  update(row.id, "state", value.replace(/[^a-zA-Z\s]/g, ""))
                }
                placeholder="State"
                error={errors[`${errKey}_state_${index}`]}
              />

              <TextInput
                label="Pin Code"
                required
                value={row.pinCode || ""}
                onChange={(value) =>
                  update(row.id, "pinCode", value.replace(/[^0-9]/g, ""))
                }
                placeholder="6-digit pin code"
                error={errors[`${errKey}_pinCode_${index}`]}
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
                label="Owner Name"
                required
                value={ownership.ownerName}
                onChange={(value) =>
                  setField(
                    "ownership",
                    "ownerName",
                    value.replace(/[0-9]/g, "")
                  )
                }
                placeholder="Full name as on PAN"
                error={errors.ownerName}
              />

              <TextInput
                label="Owner Phone Number"
                required
                value={ownership.ownerPhone}
                onChange={(value) =>
                  setField(
                    "ownership",
                    "ownerPhone",
                    value.replace(/[^0-9]/g, "").slice(0, 10)
                  )
                }
                placeholder="10-digit mobile number"
                error={errors.ownerPhone}
              />

              {/* Landline — optional */}
              <TextInput
                label="Owner Landline Number"
                value={ownership.ownerLandline || ""}
                onChange={(value) =>
                  setField(
                    "ownership",
                    "ownerLandline",
                    value.replace(/[^0-9]/g, "")
                  )
                }
                placeholder="Landline (optional)"
              />

              <TextInput
                label="Owner Email ID"
                required
                value={ownership.ownerEmail}
                onChange={(value) => setField("ownership", "ownerEmail", value)}
                placeholder="name@example.com"
                error={errors.ownerEmail}
              />

              <TextInput
                label="Owner Age"
                required
                value={(ownership as any).ownerAge || ""}
                onChange={(value) =>
                  setField(
                    "ownership",
                    "ownerAge",
                    value.replace(/[^0-9]/g, "").slice(0, 2)
                  )
                }
                placeholder="Age (18 – 90)"
                error={errors.ownerAge}
              />
            </div>

            <div className="mt-5">
              <FileUploadCard
                label="Owner Photograph"
                hint="Drag image or click to upload"
                value={(ownership as any).ownerPhoto || null}
                onChange={(item) => setUpload("ownership.ownerPhoto", item)}
                error={errors.ownerPhoto}
              />
            </div>

            <div className="mt-5">
              <p className="mb-3 text-sm font-semibold text-[#173F63]">
                Owner Residential Address
              </p>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <TextInput
                    label="Address Line 1"
                    required
                    value={(ownership as any).ownerAddressLine1 || ""}
                    onChange={(value) =>
                      setField("ownership", "ownerAddressLine1", value)
                    }
                    placeholder="House / Street / Area"
                    error={errors.ownerAddressLine1}
                  />
                </div>

                <TextInput
                  label="City"
                  required
                  value={(ownership as any).ownerCity || ""}
                  onChange={(value) =>
                    setField(
                      "ownership",
                      "ownerCity",
                      value.replace(/[^a-zA-Z\s]/g, "")
                    )
                  }
                  placeholder="City"
                  error={errors.ownerCity}
                />

                <TextInput
                  label="District"
                  required
                  value={(ownership as any).ownerDistrict || ""}
                  onChange={(value) =>
                    setField(
                      "ownership",
                      "ownerDistrict",
                      value.replace(/[^a-zA-Z\s]/g, "")
                    )
                  }
                  placeholder="District"
                  error={errors.ownerDistrict}
                />

                <TextInput
                  label="State"
                  required
                  value={(ownership as any).ownerState || ""}
                  onChange={(value) =>
                    setField(
                      "ownership",
                      "ownerState",
                      value.replace(/[^a-zA-Z\s]/g, "")
                    )
                  }
                  placeholder="State"
                  error={errors.ownerState}
                />

                <TextInput
                  label="Pin Code"
                  required
                  value={(ownership as any).ownerPinCode || ""}
                  onChange={(value) =>
                    setField(
                      "ownership",
                      "ownerPinCode",
                      value.replace(/[^0-9]/g, "")
                    )
                  }
                  placeholder="6-digit pin code"
                  error={errors.ownerPinCode}
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
            error={errors.partnershipDeed}
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
            errors={errors}
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
              error={errors.mouDocument}
            />
            <FileUploadCard
              label="AoA (Articles of Association)"
              hint="Drag file or click to upload"
              value={ownership.aoaDocument}
              onChange={(item) => setUpload("ownership.aoaDocument", item)}
              error={errors.aoaDocument}
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
            errors={errors}
          />
        </>
      )}

      <div>
        <h3 className="mb-4 text-xl font-semibold text-[#173F63]">
          Bank Account Information
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextInput
            label="Bank Name"
            required
            value={ownership.bankName}
            onChange={(value) =>
              setField(
                "ownership",
                "bankName",
                value.replace(/[^a-zA-Z\s]/g, "")
              )
            }
            placeholder="e.g. HDFC Bank"
            error={errors.bankName}
          />

          <TextInput
            label="Account Number"
            required
            value={ownership.accountNumber}
            onChange={(value) =>
              setField(
                "ownership",
                "accountNumber",
                value.replace(/[^0-9]/g, "")
              )
            }
            placeholder="Bank account number"
            error={errors.accountNumber}
          />

          <TextInput
            label="IFSC"
            required
            value={ownership.ifsc}
            onChange={(value) =>
              setField(
                "ownership",
                "ifsc",
                value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11)
              )
            }
            placeholder="11-character IFSC"
            className="uppercase"
            error={errors.ifsc}
          />

          <TextInput
            label="Beneficiary Name"
            required
            value={ownership.beneficiaryName}
            onChange={(value) =>
              setField(
                "ownership",
                "beneficiaryName",
                value.replace(/[^a-zA-Z0-9\s]/g, "")
              )
            }
            placeholder="As per bank records"
            error={errors.beneficiaryName}
          />

          <TextInput
            label="Branch"
            required
            value={(ownership as any).branch || ""}
            onChange={(value) =>
              setField(
                "ownership",
                "branch",
                value.replace(/[^a-zA-Z0-9\s]/g, "")
              )
            }
            placeholder="Branch name"
            error={errors.branch}
          />

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-[#173F63]">
              Account Type<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              value={(ownership as any).accountType || ""}
              onChange={(e) =>
                setField("ownership", "accountType", e.target.value)
              }
              className="w-full rounded-xl border border-[#E3E8EF] bg-white px-4 py-3 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
            >
              <option value="">Select account type</option>
              <option value="current">Current</option>
              <option value="savings">Savings</option>
              <option value="od">OD</option>
            </select>
            {errors.accountType ? (
              <p className="mt-1.5 text-sm text-red-600">{errors.accountType}</p>
            ) : null}
          </div>
        </div>
      </div>

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