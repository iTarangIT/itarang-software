"use client";

import { useMemo, useState } from "react";
import {
  ShieldCheck,
  CheckCircle2,
  FileText,
  ExternalLink,
  RefreshCcw,
  Clock3,
} from "lucide-react";
import { useOnboardingStore } from "@/store/onboardingStore";

const SIGNING_METHOD_OPTIONS = [
  { value: "", label: "Select Signing Method" },
  { value: "aadhaar_esign", label: "Aadhaar based E-Sign" },
  { value: "electronic_signature", label: "Electronic Signature" },
  { value: "dsc_signature", label: "DSC Signature" },
];

const STATUS_OPTIONS = [
  {
    key: "not_generated",
    label: "Not Generated",
    classes: "bg-slate-100 text-slate-700 border-slate-200",
  },
  {
    key: "draft_generated",
    label: "Draft Generated",
    classes: "bg-blue-100 text-blue-700 border-blue-200",
  },
  {
    key: "sent_for_signature",
    label: "Sent for Signature",
    classes: "bg-indigo-100 text-indigo-700 border-indigo-200",
  },
  {
    key: "viewed_by_dealer",
    label: "Viewed by Dealer",
    classes: "bg-amber-100 text-amber-700 border-amber-200",
  },
  {
    key: "signed_by_dealer",
    label: "Signed by Dealer",
    classes: "bg-green-100 text-green-700 border-green-200",
  },
  {
    key: "completed",
    label: "Completed",
    classes: "bg-emerald-100 text-emerald-700 border-emerald-200",
  },
  {
    key: "expired",
    label: "Expired",
    classes: "bg-orange-100 text-orange-700 border-orange-200",
  },
  {
    key: "failed",
    label: "Failed / Retry Required",
    classes: "bg-red-100 text-red-700 border-red-200",
  },
] as const;

function StatusBadge({ status }: { status: string }) {
  const found = STATUS_OPTIONS.find((item) => item.key === status) || STATUS_OPTIONS[0];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${found.classes}`}
    >
      {found.label}
    </span>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
      <div className="mb-5">
        <h3 className="text-lg font-bold text-[#173F63] md:text-xl">{title}</h3>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

function InputField({
  value,
  onChange,
  placeholder,
  type = "text",
  readOnly = false,
}: {
  value: string | number;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  readOnly?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100 ${
        readOnly ? "bg-slate-50 text-slate-500" : ""
      }`}
    />
  );
}

function SelectField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-2xl border border-[#E3E8EF] bg-white px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
    >
      {SIGNING_METHOD_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function PartyCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-5">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-[#1F5C8F]" />
        <h4 className="text-base font-semibold text-[#173F63]">{title}</h4>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </div>
  );
}

export default function StepAgreement() {
  const [creating, setCreating] = useState(false);

  const financeEnabled = useOnboardingStore((s) => s.finance.enableFinance);
  const company = useOnboardingStore((s) => s.company);
  const ownership = useOnboardingStore((s) => s.ownership);
  const agreement = useOnboardingStore((s) => s.agreement);
  const errors = useOnboardingStore((s) => s.errors);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const setField = useOnboardingStore((s) => s.setField);

  if (financeEnabled !== "yes") {
    return null;
  }

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
        label: `${partner.name || "Partner"} - ${partner.designation || "Partner"}`,
        name: partner.name || "",
        designation: partner.designation || "Partner",
        email: partner.email || "",
        mobile: partner.phone || "",
      }));
    }

    if (company.companyType === "private_limited_firm") {
      return (ownership.directors || []).map((director) => ({
        label: `${director.name || "Director"} - ${director.designation || "Director"}`,
        name: director.name || "",
        designation: director.designation || "Director",
        email: director.email || "",
        mobile: director.phone || "",
      }));
    }

    return [];
  }, [company.companyType, ownership]);

  const onDealerSignatoryChange = (selectedName: string) => {
    const selected = dealerSignatoryOptions.find((item) => item.name === selectedName);
    if (!selected) return;

    setField("agreement", "dealerSignerName", selected.name);
    setField("agreement", "dealerSignerDesignation", selected.designation);
    setField("agreement", "dealerSignerEmail", selected.email);
    setField("agreement", "dealerSignerPhone", selected.mobile);
  };

  const signerOrder = [
    "Dealer Signatory",
    "Financier Signatory",
    "iTarang Signatory 1",
    "iTarang Signatory 2",
    ...(agreement.includeWitnessesInSigning ? ["Witness 1", "Witness 2"] : []),
  ];

  const canGenerateAgreement = useMemo(() => {
    const a = agreement;

    const baseRequired =
      !!a.dateOfSigning &&
      !!a.itarangSignatory1.name &&
      !!a.itarangSignatory1.designation &&
      !!a.itarangSignatory1.email &&
      !!a.itarangSignatory1.mobile &&
      !!a.itarangSignatory1.signingMethod &&
      !!a.itarangSignatory2.name &&
      !!a.itarangSignatory2.designation &&
      !!a.itarangSignatory2.email &&
      !!a.itarangSignatory2.mobile &&
      !!a.itarangSignatory2.signingMethod &&
      !!a.dealerSignerName &&
      !!a.dealerSignerDesignation &&
      !!a.dealerSignerEmail &&
      !!a.dealerSignerPhone &&
      !!a.dealerSigningMethod &&
      !!a.mouDate &&
      !!a.financierName &&
      !!a.financierSignatory.name &&
      !!a.financierSignatory.email &&
      !!a.financierSignatory.mobile &&
      !!a.financierSignatory.address &&
      !!a.financierSignatory.signingMethod &&
      !!a.witness1.name &&
      !!a.witness1.email &&
      !!a.witness1.mobile &&
      !!a.witness1.address &&
      !!a.witness1.signingMethod &&
      !!a.witness2.name &&
      !!a.witness2.email &&
      !!a.witness2.mobile &&
      !!a.witness2.address &&
      !!a.witness2.signingMethod &&
      !!a.expiryDays;

    if (!a.isOemFinancing) return baseRequired;

    return (
      baseRequired &&
      !!a.vehicleType &&
      !!a.manufacturer &&
      !!a.brand &&
      !!a.statePresence
    );
  }, [agreement]);

  const handleGenerateViaDigio = async () => {
    try {
      setCreating(true);

      const currentState = useOnboardingStore.getState();

      const response = await fetch("/api/integrations/digio/create-agreement", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(currentState),
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        alert(json.message || "Failed to generate agreement via Digio");
        return;
      }

      setField("agreement", "providerDocumentId", json.data.providerDocumentId || "");
      setField("agreement", "requestId", json.data.requestId || "");
      setField("agreement", "providerSigningUrl", json.data.signingUrl || "");
      setField("agreement", "providerRawResponse", json.data.rawResponse || "");
      setField("agreement", "agreementStatus", json.data.status || "sent_for_signature");
      setField("agreement", "generatedDate", new Date().toISOString());
      setField("agreement", "lastActionTimestamp", new Date().toISOString());
      setField("agreement", "completionStatus", "Sent for Signature");
    } catch (error) {
      console.error("DIGIO GENERATE ERROR:", error);
      alert("Failed to generate agreement via Digio");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-[#E3E8EF] bg-gradient-to-br from-white to-[#F7FAFD] p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-[#1F5C8F]">
              Dealer Finance Agreement
            </p>
            <h2 className="mt-2 text-2xl font-bold text-[#173F63] md:text-3xl">
              Digio Agreement Orchestration
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-500 md:text-base">
              CRM captures agreement-specific data only. Digio owns template execution,
              eStamping, signing workflow, and final agreement generation.
            </p>
          </div>

          <div className="min-w-[280px] rounded-2xl border border-[#E3E8EF] bg-white p-4 shadow-sm">
            <div className="space-y-2 text-sm text-slate-600">
              <p>
                <span className="font-semibold text-slate-800">Provider:</span>{" "}
                {agreement.provider || "Digio"}
              </p>
              <p>
                <span className="font-semibold text-slate-800">Template Source:</span>{" "}
                {agreement.templateSource || "Digio Template"}
              </p>
              <p>
                <span className="font-semibold text-slate-800">Generated On:</span>{" "}
                {agreement.generatedDate
                  ? new Date(agreement.generatedDate).toLocaleString()
                  : "Not generated yet"}
              </p>
              <p>
                <span className="font-semibold text-slate-800">Expiry:</span>{" "}
                {agreement.expiryDays} day(s)
              </p>
            </div>

            <div className="mt-4">
              <StatusBadge status={agreement.agreementStatus} />
            </div>
          </div>
        </div>
      </div>

      <SectionCard
        title="Agreement Meta"
        subtitle="Only new agreement-specific data is collected here. Previously captured onboarding data is lookup-only."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <InputField
              type="date"
              value={agreement.dateOfSigning}
              onChange={(value) => setField("agreement", "dateOfSigning", value)}
              placeholder="Date of Signing"
            />
            {errors.dateOfSigning && (
              <p className="mt-2 text-sm text-red-600">{errors.dateOfSigning}</p>
            )}
          </div>

          <div>
            <InputField
              type="number"
              value={agreement.expiryDays}
              onChange={(value) =>
                setField("agreement", "expiryDays", Number(value || 0))
              }
              placeholder="Expiry Days"
            />
            {errors.expiryDays && (
              <p className="mt-2 text-sm text-red-600">{errors.expiryDays}</p>
            )}
          </div>

          <div>
            <select
              value={agreement.sequenceMode}
              onChange={(e) => setField("agreement", "sequenceMode", e.target.value)}
              className="w-full rounded-2xl border border-[#E3E8EF] bg-white px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
            >
              <option value="sequential">Sequential Signing</option>
              <option value="parallel">Parallel Signing</option>
            </select>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="iTarang Signatories (2 Required)"
        subtitle="These are new agreement inputs and required for Digio signer sequence."
      >
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <PartyCard title="iTarang Signatory 1">
            <InputField
              value={agreement.itarangSignatory1.name}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...agreement.itarangSignatory1,
                  name: value,
                })
              }
              placeholder="Name"
            />
            <InputField
              value={agreement.itarangSignatory1.designation}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...agreement.itarangSignatory1,
                  designation: value,
                })
              }
              placeholder="Designation"
            />
            <InputField
              value={agreement.itarangSignatory1.email}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...agreement.itarangSignatory1,
                  email: value,
                })
              }
              placeholder="Email"
            />
            <InputField
              value={agreement.itarangSignatory1.mobile}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...agreement.itarangSignatory1,
                  mobile: value.replace(/[^0-9]/g, ""),
                })
              }
              placeholder="Mobile"
            />
            <div className="md:col-span-2">
              <SelectField
                value={agreement.itarangSignatory1.signingMethod}
                onChange={(value) =>
                  setField("agreement", "itarangSignatory1", {
                    ...agreement.itarangSignatory1,
                    signingMethod: value,
                  })
                }
              />
            </div>
          </PartyCard>

          <PartyCard title="iTarang Signatory 2">
            <InputField
              value={agreement.itarangSignatory2.name}
              onChange={(value) =>
                setField("agreement", "itarangSignatory2", {
                  ...agreement.itarangSignatory2,
                  name: value,
                })
              }
              placeholder="Name"
            />
            <InputField
              value={agreement.itarangSignatory2.designation}
              onChange={(value) =>
                setField("agreement", "itarangSignatory2", {
                  ...agreement.itarangSignatory2,
                  designation: value,
                })
              }
              placeholder="Designation"
            />
            <InputField
              value={agreement.itarangSignatory2.email}
              onChange={(value) =>
                setField("agreement", "itarangSignatory2", {
                  ...agreement.itarangSignatory2,
                  email: value,
                })
              }
              placeholder="Email"
            />
            <InputField
              value={agreement.itarangSignatory2.mobile}
              onChange={(value) =>
                setField("agreement", "itarangSignatory2", {
                  ...agreement.itarangSignatory2,
                  mobile: value.replace(/[^0-9]/g, ""),
                })
              }
              placeholder="Mobile"
            />
            <div className="md:col-span-2">
              <SelectField
                value={agreement.itarangSignatory2.signingMethod}
                onChange={(value) =>
                  setField("agreement", "itarangSignatory2", {
                    ...agreement.itarangSignatory2,
                    signingMethod: value,
                  })
                }
              />
            </div>
          </PartyCard>
        </div>
      </SectionCard>

      <SectionCard
        title="Dealer Signatory"
        subtitle="Dealer person is chosen from previously captured onboarding data. Details are lookup-only."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <select
            value={agreement.dealerSignerName}
            onChange={(e) => onDealerSignatoryChange(e.target.value)}
            className="w-full rounded-2xl border border-[#E3E8EF] bg-white px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            <option value="">Choose Dealer Signatory</option>
            {dealerSignatoryOptions.map((item, index) => (
              <option key={`${item.name}-${index}`} value={item.name}>
                {item.label}
              </option>
            ))}
          </select>

          <SelectField
            value={agreement.dealerSigningMethod}
            onChange={(value) => setField("agreement", "dealerSigningMethod", value)}
          />

          <InputField
            value={agreement.dealerSignerDesignation}
            onChange={() => {}}
            placeholder="Designation"
            readOnly
          />
          <InputField
            value={agreement.dealerSignerEmail}
            onChange={() => {}}
            placeholder="Email"
            readOnly
          />
          <InputField
            value={agreement.dealerSignerPhone}
            onChange={() => {}}
            placeholder="Mobile"
            readOnly
          />
        </div>
      </SectionCard>

      <SectionCard
        title="OEM Section"
        subtitle="Shown only when OEM financing is applicable for this agreement."
      >
        <div className="space-y-4">
          <label className="flex items-center gap-3 text-sm font-medium text-[#173F63]">
            <input
              type="checkbox"
              checked={agreement.isOemFinancing}
              onChange={(e) => setField("agreement", "isOemFinancing", e.target.checked)}
            />
            Is OEM Financing?
          </label>

          {agreement.isOemFinancing && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <select
                  value={agreement.vehicleType}
                  onChange={(e) => setField("agreement", "vehicleType", e.target.value)}
                  className="w-full rounded-2xl border border-[#E3E8EF] bg-white px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
                >
                  <option value="">Vehicle Type</option>
                  <option value="e_rickshaw">E-Rickshaw</option>
                  <option value="loader">Loader</option>
                </select>
                {errors.vehicleType && (
                  <p className="mt-2 text-sm text-red-600">{errors.vehicleType}</p>
                )}
              </div>

              <InputField
                value={agreement.manufacturer}
                onChange={(value) => setField("agreement", "manufacturer", value)}
                placeholder="Manufacturer"
              />
              <InputField
                value={agreement.brand}
                onChange={(value) => setField("agreement", "brand", value)}
                placeholder="Brand"
              />
              <InputField
                value={agreement.statePresence}
                onChange={(value) => setField("agreement", "statePresence", value)}
                placeholder="State Presence"
              />
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="MoU & Financier Section"
        subtitle="Agreement-specific financier data used by Digio for MoU generation and signer sequencing."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InputField
            type="date"
            value={agreement.mouDate}
            onChange={(value) => setField("agreement", "mouDate", value)}
            placeholder="MoU Date"
          />
          <InputField
            value={agreement.financierName}
            onChange={(value) => setField("agreement", "financierName", value)}
            placeholder="Financier Name"
          />
        </div>

        <div className="mt-6">
          <PartyCard title="Financier Signatory">
            <InputField
              value={agreement.financierSignatory.name}
              onChange={(value) =>
                setField("agreement", "financierSignatory", {
                  ...agreement.financierSignatory,
                  name: value,
                })
              }
              placeholder="Name"
            />
            <InputField
              value={agreement.financierSignatory.email}
              onChange={(value) =>
                setField("agreement", "financierSignatory", {
                  ...agreement.financierSignatory,
                  email: value,
                })
              }
              placeholder="Email"
            />
            <InputField
              value={agreement.financierSignatory.mobile}
              onChange={(value) =>
                setField("agreement", "financierSignatory", {
                  ...agreement.financierSignatory,
                  mobile: value.replace(/[^0-9]/g, ""),
                })
              }
              placeholder="Mobile"
            />
            <InputField
              value={agreement.financierSignatory.address || ""}
              onChange={(value) =>
                setField("agreement", "financierSignatory", {
                  ...agreement.financierSignatory,
                  address: value,
                })
              }
              placeholder="Address"
            />
            <div className="md:col-span-2">
              <SelectField
                value={agreement.financierSignatory.signingMethod}
                onChange={(value) =>
                  setField("agreement", "financierSignatory", {
                    ...agreement.financierSignatory,
                    signingMethod: value,
                  })
                }
              />
            </div>
          </PartyCard>
        </div>
      </SectionCard>

      <SectionCard
        title="Witness Details (2 Required)"
        subtitle="Witnesses remain agreement data fields. They can be informational-only or added into the Digio signing workflow."
      >
        <div className="mb-4">
          <label className="flex items-center gap-3 text-sm font-medium text-[#173F63]">
            <input
              type="checkbox"
              checked={agreement.includeWitnessesInSigning}
              onChange={(e) =>
                setField("agreement", "includeWitnessesInSigning", e.target.checked)
              }
            />
            Include witnesses in signing workflow
          </label>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <PartyCard title="Witness 1">
            <InputField
              value={agreement.witness1.name}
              onChange={(value) =>
                setField("agreement", "witness1", {
                  ...agreement.witness1,
                  name: value,
                })
              }
              placeholder="Name"
            />
            <InputField
              value={agreement.witness1.email}
              onChange={(value) =>
                setField("agreement", "witness1", {
                  ...agreement.witness1,
                  email: value,
                })
              }
              placeholder="Email"
            />
            <InputField
              value={agreement.witness1.mobile}
              onChange={(value) =>
                setField("agreement", "witness1", {
                  ...agreement.witness1,
                  mobile: value.replace(/[^0-9]/g, ""),
                })
              }
              placeholder="Mobile"
            />
            <InputField
              value={agreement.witness1.address}
              onChange={(value) =>
                setField("agreement", "witness1", {
                  ...agreement.witness1,
                  address: value,
                })
              }
              placeholder="Address"
            />
            <div className="md:col-span-2">
              <SelectField
                value={agreement.witness1.signingMethod}
                onChange={(value) =>
                  setField("agreement", "witness1", {
                    ...agreement.witness1,
                    signingMethod: value,
                  })
                }
              />
            </div>
          </PartyCard>

          <PartyCard title="Witness 2">
            <InputField
              value={agreement.witness2.name}
              onChange={(value) =>
                setField("agreement", "witness2", {
                  ...agreement.witness2,
                  name: value,
                })
              }
              placeholder="Name"
            />
            <InputField
              value={agreement.witness2.email}
              onChange={(value) =>
                setField("agreement", "witness2", {
                  ...agreement.witness2,
                  email: value,
                })
              }
              placeholder="Email"
            />
            <InputField
              value={agreement.witness2.mobile}
              onChange={(value) =>
                setField("agreement", "witness2", {
                  ...agreement.witness2,
                  mobile: value.replace(/[^0-9]/g, ""),
                })
              }
              placeholder="Mobile"
            />
            <InputField
              value={agreement.witness2.address}
              onChange={(value) =>
                setField("agreement", "witness2", {
                  ...agreement.witness2,
                  address: value,
                })
              }
              placeholder="Address"
            />
            <div className="md:col-span-2">
              <SelectField
                value={agreement.witness2.signingMethod}
                onChange={(value) =>
                  setField("agreement", "witness2", {
                    ...agreement.witness2,
                    signingMethod: value,
                  })
                }
              />
            </div>
          </PartyCard>
        </div>
      </SectionCard>

      <SectionCard
        title="Signing Order and Signing Sequence"
        subtitle="This order is shown clearly to both review and admin screens so pending-next signer can be understood."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {signerOrder.map((item, index) => (
            <div
              key={item}
              className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4"
            >
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-[#1F5C8F] text-sm font-bold text-white">
                {index + 1}
              </div>
              <p className="text-sm font-semibold text-slate-800">{item}</p>
              <p className="mt-1 text-xs text-slate-500">
                {agreement.sequenceMode === "sequential"
                  ? "Sequential workflow"
                  : "Parallel workflow"}
              </p>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Digio Execution Panel"
        subtitle="CRM sends structured agreement data to Digio. Digio generates the agreement, applies eStamp, and handles signing."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Request ID</p>
            <p className="mt-2 text-sm font-semibold text-slate-800">
              {agreement.requestId || "Pending"}
            </p>
          </div>

          <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Provider Document ID</p>
            <p className="mt-2 text-sm font-semibold text-slate-800">
              {agreement.providerDocumentId || "Pending"}
            </p>
          </div>

          <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
            <div className="mt-2">
              <StatusBadge status={agreement.agreementStatus} />
            </div>
          </div>

          <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Last Action</p>
            <p className="mt-2 text-sm font-semibold text-slate-800">
              {agreement.lastActionTimestamp
                ? new Date(agreement.lastActionTimestamp).toLocaleString()
                : "Pending"}
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={handleGenerateViaDigio}
            disabled={!canGenerateAgreement || creating}
            className={`inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold ${
              !canGenerateAgreement || creating
                ? "cursor-not-allowed bg-slate-200 text-slate-500"
                : "bg-[#1F5C8F] text-white hover:bg-[#173F63]"
            }`}
          >
            <FileText className="h-4 w-4" />
            {creating ? "Generating..." : "Generate via Digio"}
          </button>

          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCcw className="h-4 w-4" />
            Refresh Status
          </button>

          {agreement.providerSigningUrl ? (
            <a
              href={agreement.providerSigningUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open Signing Link
            </a>
          ) : null}
        </div>

        {!canGenerateAgreement && (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Continue to Review will work only after all required agreement fields are filled.
          </div>
        )}

        {agreement.agreementStatus === "expired" && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
            <Clock3 className="h-4 w-4" />
            Agreement request has expired. Re-initiate agreement or upload signed agreement and audit trail manually.
          </div>
        )}

        {agreement.agreementStatus === "completed" && (
          <div className="mt-4 flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <CheckCircle2 className="h-4 w-4" />
            Agreement has been completed successfully.
          </div>
        )}
      </SectionCard>

      <div className="flex items-center justify-between gap-4">
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
          disabled={!canGenerateAgreement}
          className={`inline-flex items-center justify-center rounded-2xl px-6 py-3 text-sm font-semibold ${
            canGenerateAgreement
              ? "bg-[#1F5C8F] text-white hover:bg-[#173F63]"
              : "cursor-not-allowed bg-slate-200 text-slate-500"
          }`}
        >
          Continue to Review →
        </button>
      </div>
    </div>
  );
}