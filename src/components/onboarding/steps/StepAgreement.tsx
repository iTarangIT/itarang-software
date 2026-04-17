"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Clock3, CheckCircle2, Info, AlertCircle, Plus, X } from "lucide-react";
import { useOnboardingStore } from "@/store/onboardingStore";

type SigningMethod =
  | ""
  | "aadhaar_esign"
  | "electronic_signature"
  | "dsc_signature";

const SIGNING_METHOD_OPTIONS: { value: SigningMethod; label: string }[] = [
  { value: "", label: "Select signing method" },
  { value: "aadhaar_esign", label: "Aadhaar eSign" },
  { value: "electronic_signature", label: "Electronic Signature" },
  { value: "dsc_signature", label: "DSC Signature" },
];

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-xs text-red-500">{message}</p>;
}

function InputField({
  value,
  onChange,
  placeholder,
  type = "text",
  readOnly = false,
  error,
}: {
  value: string | number | undefined | null;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  readOnly?: boolean;
  error?: string;
}) {
  return (
    <div>
      <input
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        className={`w-full rounded-2xl border px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 ${
          error
            ? "border-red-400 bg-red-50 focus:border-red-400"
            : readOnly
            ? "border-[#E3E8EF] bg-slate-50 text-slate-500"
            : "border-[#E3E8EF] bg-white focus:border-[#1F5C8F]"
        }`}
      />
      <FieldError message={error} />
    </div>
  );
}

function SelectField({
  value,
  onChange,
  error,
}: {
  value: SigningMethod;
  onChange: (value: SigningMethod) => void;
  error?: string;
}) {
  return (
    <div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SigningMethod)}
        className={`w-full rounded-2xl border px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 ${
          error
            ? "border-red-400 bg-red-50 focus:border-red-400"
            : "border-[#E3E8EF] bg-white focus:border-[#1F5C8F]"
        }`}
      >
        {SIGNING_METHOD_OPTIONS.map((option) => (
          <option key={option.value || "empty"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldError message={error} />
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
      <div className="mb-5">
        <h3 className="text-lg font-semibold text-[#173F63]">{title}</h3>
        {subtitle ? (
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function PartyCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-4">
        <h4 className="text-sm font-semibold text-slate-800">{title}</h4>
        {subtitle ? (
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </div>
  );
}

export default function StepAgreement() {
  const financeEnabled = useOnboardingStore((s) => s.finance.enableFinance);
  const company = useOnboardingStore((s) => s.company);
  const ownership = useOnboardingStore((s) => s.ownership);
  const agreement = useOnboardingStore((s) => s.agreement);
  const errors = useOnboardingStore((s) => s.errors);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const setField = useOnboardingStore((s) => s.setField);

  // Controls visibility of the optional iTarang Signatory 2
  const [showSignatory2, setShowSignatory2] = useState(false);

  const dealerSignatoryOptions = useMemo(() => {
    if (company.companyType === "sole_proprietorship") {
      return [
        {
          label: ownership.ownerName || "Owner",
          name: ownership.ownerName || "",
          designation: "Owner",
          email: ownership.ownerEmail || "",
          mobile: ownership.ownerPhone || "",
        },
      ];
    }

    if (company.companyType === "partnership_firm") {
      return (ownership.partners || []).map((partner) => ({
        label: `${partner?.name || "Partner"} - ${
          partner?.designation || "Partner"
        }`,
        name: partner?.name || "",
        designation: partner?.designation || "Partner",
        email: partner?.email || "",
        mobile: partner?.phone || "",
      }));
    }

    if (company.companyType === "private_limited_firm") {
      return (ownership.directors || []).map((director) => ({
        label: `${director?.name || "Director"} - ${
          director?.designation || "Director"
        }`,
        name: director?.name || "",
        designation: director?.designation || "Director",
        email: director?.email || "",
        mobile: director?.phone || "",
      }));
    }

    return [];
  }, [company.companyType, ownership]);

  const onDealerSignatoryChange = (selectedName: string) => {
    const selected = dealerSignatoryOptions.find(
      (item) => item.name === selectedName
    );
    if (!selected) return;

    setField("agreement", "dealerSignerName", selected.name);
    setField("agreement", "dealerSignerDesignation", selected.designation);
    setField("agreement", "dealerSignerEmail", selected.email);
    setField("agreement", "dealerSignerPhone", selected.mobile);
  };

  const handleRemoveSignatory2 = () => {
    setShowSignatory2(false);
    // Clear signatory 2 data when removed
    setField("agreement", "itarangSignatory2", {
      name: "",
      designation: "",
      email: "",
      mobile: "",
      address: "",
      signingMethod: "",
    });
  };

  const errorCount = Object.keys(errors).length;

  if (financeEnabled !== "yes") return null;

  return (
    <div className="space-y-6">
      {/* ── Error banner ── */}
      {errorCount > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Please fill in all required fields before continuing.{" "}
              <span className="font-semibold">
                {errorCount} field{errorCount !== 1 ? "s" : ""} need
                {errorCount === 1 ? "s" : ""} attention.
              </span>
            </p>
          </div>
        </div>
      )}

      <SectionCard
        title="Dealer Finance Agreement Setup"
        subtitle="Fill agreement and signer details. Agreement will be initiated by admin after review."
      >
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              This step only captures agreement data. The iTarang admin team
              will review this information and then initiate the Digio agreement
              from admin side.
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Agreement Meta"
        subtitle="Basic agreement dates used for final agreement generation"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InputField
            type="date"
            value={agreement.dateOfSigning}
            onChange={(value) => setField("agreement", "dateOfSigning", value)}
            placeholder="Date of signing"
            error={errors.dateOfSigning}
          />
          <InputField
            type="date"
            value={agreement.mouDate}
            onChange={(value) => setField("agreement", "mouDate", value)}
            placeholder="MoU Date"
            error={errors.mouDate}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Dealer Signatory"
        subtitle="Dealer signer is selected from ownership details already captured earlier"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <select
              value={agreement.dealerSignerName || ""}
              onChange={(e) => onDealerSignatoryChange(e.target.value)}
              className={`w-full rounded-2xl border px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 ${
                errors.dealerSignerName
                  ? "border-red-400 bg-red-50"
                  : "border-[#E3E8EF] bg-white focus:border-[#1F5C8F]"
              }`}
            >
              <option value="">Choose Dealer Signatory</option>
              {dealerSignatoryOptions.map((item) => (
                <option key={`${item.name}-${item.email}`} value={item.name}>
                  {item.label}
                </option>
              ))}
            </select>
            <FieldError message={errors.dealerSignerName} />
          </div>

          <SelectField
            value={(agreement.dealerSigningMethod || "") as SigningMethod}
            onChange={(value) =>
              setField("agreement", "dealerSigningMethod", value)
            }
            error={errors.dealerSigningMethod}
          />

          <InputField
            value={agreement.dealerSignerDesignation}
            onChange={() => undefined}
            placeholder="Dealer Signatory Designation"
            readOnly
            error={errors.dealerSignerDesignation}
          />
          <InputField
            value={agreement.dealerSignerEmail}
            onChange={() => undefined}
            placeholder="Dealer Signatory Email"
            readOnly
            error={errors.dealerSignerEmail}
          />
          <InputField
            value={agreement.dealerSignerPhone}
            onChange={() => undefined}
            placeholder="Dealer Signatory Mobile"
            readOnly
            error={errors.dealerSignerPhone}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Sales Manager Information"
        subtitle="Details of the sales manager handling this dealer relationship"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InputField
            value={agreement.salesManager?.name || ""}
            onChange={(value) =>
              setField("agreement", "salesManager", {
                ...(agreement.salesManager || {}),
                name: value,
              })
            }
            placeholder="Sales Manager Name"
          />
          <InputField
            value={agreement.salesManager?.email || ""}
            onChange={(value) =>
              setField("agreement", "salesManager", {
                ...(agreement.salesManager || {}),
                email: value,
              })
            }
            placeholder="Sales Manager Email"
            type="email"
          />
          <InputField
            value={agreement.salesManager?.mobile || ""}
            onChange={(value) =>
              setField("agreement", "salesManager", {
                ...(agreement.salesManager || {}),
                mobile: value.replace(/[^0-9]/g, ""),
              })
            }
            placeholder="Sales Manager Contact Number"
          />
        </div>
      </SectionCard>

      {/* ── iTarang Signatories ── */}
      <SectionCard
        title="iTarang Signatories"
        subtitle="Internal iTarang signers who will sign after dealer and financier"
      >
        <div className="space-y-4">
          {/* Signatory 1 — always visible */}
          <PartyCard
            title="iTarang Signatory 1"
            subtitle="Primary internal signer"
          >
            <InputField
              value={agreement.itarangSignatory1?.name || ""}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...(agreement.itarangSignatory1 || {}),
                  name: value,
                })
              }
              placeholder="Signatory Name"
              error={errors.itarangSignatory1_name}
            />
            <InputField
              value={agreement.itarangSignatory1?.designation || ""}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...(agreement.itarangSignatory1 || {}),
                  designation: value,
                })
              }
              placeholder="Designation"
              error={errors.itarangSignatory1_designation}
            />
            <InputField
              value={agreement.itarangSignatory1?.email || ""}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...(agreement.itarangSignatory1 || {}),
                  email: value,
                })
              }
              placeholder="Signatory Email"
              error={errors.itarangSignatory1_email}
            />
            <InputField
              value={agreement.itarangSignatory1?.mobile || ""}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...(agreement.itarangSignatory1 || {}),
                  mobile: value.replace(/[^0-9]/g, ""),
                })
              }
              placeholder="Signatory Mobile"
              error={errors.itarangSignatory1_mobile}
            />
            <InputField
              value={agreement.itarangSignatory1?.address || ""}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...(agreement.itarangSignatory1 || {}),
                  address: value,
                })
              }
              placeholder="Signatory Address"
            />
            <SelectField
              value={
                (agreement.itarangSignatory1?.signingMethod || "") as SigningMethod
              }
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...(agreement.itarangSignatory1 || {}),
                  signingMethod: value,
                })
              }
              error={errors.itarangSignatory1_signingMethod}
            />
          </PartyCard>

          {/* Signatory 2 — optional, toggled by button */}
          {showSignatory2 ? (
            <div className="relative">
              {/* Remove button */}
              <button
                type="button"
                onClick={handleRemoveSignatory2}
                className="absolute -right-2 -top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-red-200 bg-white text-red-400 shadow-sm hover:bg-red-50 hover:text-red-600"
                title="Remove Signatory 2"
              >
                <X className="h-3.5 w-3.5" />
              </button>

              <PartyCard
                title="iTarang Signatory 2"
                subtitle="Secondary internal signer (optional)"
              >
                <InputField
                  value={agreement.itarangSignatory2?.name || ""}
                  onChange={(value) =>
                    setField("agreement", "itarangSignatory2", {
                      ...(agreement.itarangSignatory2 || {}),
                      name: value,
                    })
                  }
                  placeholder="Signatory Name"
                  error={errors.itarangSignatory2_name}
                />
                <InputField
                  value={agreement.itarangSignatory2?.designation || ""}
                  onChange={(value) =>
                    setField("agreement", "itarangSignatory2", {
                      ...(agreement.itarangSignatory2 || {}),
                      designation: value,
                    })
                  }
                  placeholder="Designation"
                  error={errors.itarangSignatory2_designation}
                />
                <InputField
                  value={agreement.itarangSignatory2?.email || ""}
                  onChange={(value) =>
                    setField("agreement", "itarangSignatory2", {
                      ...(agreement.itarangSignatory2 || {}),
                      email: value,
                    })
                  }
                  placeholder="Signatory Email"
                  error={errors.itarangSignatory2_email}
                />
                <InputField
                  value={agreement.itarangSignatory2?.mobile || ""}
                  onChange={(value) =>
                    setField("agreement", "itarangSignatory2", {
                      ...(agreement.itarangSignatory2 || {}),
                      mobile: value.replace(/[^0-9]/g, ""),
                    })
                  }
                  placeholder="Signatory Mobile"
                  error={errors.itarangSignatory2_mobile}
                />
                <InputField
                  value={agreement.itarangSignatory2?.address || ""}
                  onChange={(value) =>
                    setField("agreement", "itarangSignatory2", {
                      ...(agreement.itarangSignatory2 || {}),
                      address: value,
                    })
                  }
                  placeholder="Signatory Address"
                />
                <SelectField
                  value={
                    (agreement.itarangSignatory2?.signingMethod || "") as SigningMethod
                  }
                  onChange={(value) =>
                    setField("agreement", "itarangSignatory2", {
                      ...(agreement.itarangSignatory2 || {}),
                      signingMethod: value,
                    })
                  }
                  error={errors.itarangSignatory2_signingMethod}
                />
              </PartyCard>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowSignatory2(true)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-[#173F63] px-4 py-3.5 text-sm font-medium text-[#173F63] transition hover:bg-blue-50"
            >
              <Plus className="h-4 w-4" />
              Add iTarang Signatory 2
            </button>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Signing Workflow"
        subtitle="This is the fixed signing order used by admin while initiating agreement"
      >
        <div className="space-y-3 text-sm">
          <div className="rounded-xl border border-[#E3E8EF] bg-[#FAFBFC] p-3">
            1. Dealer Signatory
          </div>
          <div className="rounded-xl border border-[#E3E8EF] bg-[#FAFBFC] p-3">
            2. iTarang Signatory 1
          </div>
          {showSignatory2 && (
            <div className="rounded-xl border border-[#E3E8EF] bg-[#FAFBFC] p-3">
              3. iTarang Signatory 2
            </div>
          )}
        </div>
      </SectionCard>

      <div className="flex items-center justify-between rounded-3xl border border-[#E3E8EF] bg-white p-5 shadow-sm">
        <button
          type="button"
          onClick={prevStep}
          className="rounded-2xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Back
        </button>

        <div className="flex items-center gap-3 text-sm text-slate-500">
          <Clock3 className="h-4 w-4" />
          Step 5 of 6
        </div>

        <button
          type="button"
          onClick={() => {
            const ok = nextStep();
            if (!ok) {
              setTimeout(() => {
                const firstError = document.querySelector(".text-red-500");
                firstError?.scrollIntoView({ behavior: "smooth", block: "center" });
              }, 50);
            }
          }}
          className="inline-flex items-center gap-2 rounded-2xl bg-[#173F63] px-5 py-3 text-sm font-semibold text-white hover:bg-[#12324f]"
        >
          <CheckCircle2 className="h-4 w-4" />
          Continue to Review
        </button>
      </div>
    </div>
  );
}