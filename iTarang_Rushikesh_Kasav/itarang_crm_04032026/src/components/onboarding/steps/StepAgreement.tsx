"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { useOnboardingStore } from "@/store/onboardingStore";

type SigningMethod =
  | ""
  | "aadhaar_esign"
  | "electronic_signature"
  | "dsc_signature";

type SequenceMode = "sequential" | "parallel";

type AgreementStatusType =
  | "not_generated"
  | "sent_for_signature"
  | "viewed_by_dealer"
  | "completed"
  | "failed"
  | "expired";

type SignerUrlItem = {
  name: string;
  reason: string;
  identifier: string;
  authenticationUrl: string;
  status: string;
};

const SIGNING_METHOD_OPTIONS: { value: SigningMethod; label: string }[] = [
  { value: "", label: "Select signing method" },
  { value: "aadhaar_esign", label: "Aadhaar eSign" },
  { value: "electronic_signature", label: "Electronic Signature" },
  { value: "dsc_signature", label: "DSC Signature" },
];

function InputField({
  value,
  onChange,
  placeholder,
  type = "text",
  readOnly = false,
}: {
  value: string | number | undefined | null;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  readOnly?: boolean;
}) {
  return (
    <input
      type={type}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      readOnly={readOnly}
      className={`w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100 ${readOnly ? "bg-slate-50 text-slate-500" : "bg-white"
        }`}
    />
  );
}

function SelectField({
  value,
  onChange,
}: {
  value: SigningMethod;
  onChange: (value: SigningMethod) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SigningMethod)}
      className="w-full rounded-2xl border border-[#E3E8EF] bg-white px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
    >
      {SIGNING_METHOD_OPTIONS.map((option) => (
        <option key={option.value || "empty"} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <h4 className="mb-4 text-sm font-semibold text-slate-800">{title}</h4>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | undefined }) {
  const map: Record<string, string> = {
    not_generated: "bg-slate-100 text-slate-700 border-slate-200",
    sent_for_signature: "bg-indigo-100 text-indigo-700 border-indigo-200",
    viewed_by_dealer: "bg-amber-100 text-amber-700 border-amber-200",
    completed: "bg-emerald-100 text-emerald-700 border-emerald-200",
    failed: "bg-red-100 text-red-700 border-red-200",
    expired: "bg-orange-100 text-orange-700 border-orange-200",
  };

  const safeStatus = status || "not_generated";

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${map[safeStatus] || map.not_generated
        }`}
    >
      {safeStatus.replaceAll("_", " ")}
    </span>
  );
}

export default function StepAgreement() {
  const [creating, setCreating] = useState(false);

  const financeEnabled = useOnboardingStore((s) => s.finance.enableFinance);
  const company = useOnboardingStore((s) => s.company);
  const ownership = useOnboardingStore((s) => s.ownership);
  const agreement = useOnboardingStore((s) => s.agreement);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const setField = useOnboardingStore((s) => s.setField);
  const resetAgreementState = useOnboardingStore((s) => s.resetAgreementState);

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
        label: `${partner?.name || "Partner"} - ${partner?.designation || "Partner"}`,
        name: partner?.name || "",
        designation: partner?.designation || "Partner",
        email: partner?.email || "",
        mobile: partner?.phone || "",
      }));
    }

    if (company.companyType === "private_limited_firm") {
      return (ownership.directors || []).map((director) => ({
        label: `${director?.name || "Director"} - ${director?.designation || "Director"}`,
        name: director?.name || "",
        designation: director?.designation || "Director",
        email: director?.email || "",
        mobile: director?.phone || "",
      }));
    }

    return [];
  }, [company.companyType, ownership]);

  const signerLinks: SignerUrlItem[] = useMemo(() => {
    if (!agreement.providerRawResponse) return [];

    try {
      const parsed = JSON.parse(agreement.providerRawResponse);

      const items: any[] = Array.isArray(parsed?.signerUrls)
        ? parsed.signerUrls
        : Array.isArray(parsed?.signing_parties)
          ? parsed.signing_parties
          : [];

      return items
        .map((party: any): SignerUrlItem => ({
          name: party?.name || "",
          reason: party?.reason || "",
          identifier: party?.identifier || "",
          authenticationUrl:
            party?.authenticationUrl || party?.authentication_url || "",
          status: party?.status || "",
        }))
        .filter((item: SignerUrlItem) => !!item.authenticationUrl);
    } catch {
      return [];
    }
  }, [agreement.providerRawResponse]);

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

  const canGenerateAgreement = useMemo(() => {
    const a = agreement;

    const coreRequired =
      !!a.dateOfSigning &&
      !!a.expiryDays &&
      !!a.dealerSignerName &&
      !!a.dealerSignerDesignation &&
      !!a.dealerSignerEmail &&
      !!a.dealerSignerPhone &&
      !!a.dealerSigningMethod &&
      !!a.financierName &&
      !!a.financierSignatory?.name &&
      !!a.financierSignatory?.designation &&
      !!a.financierSignatory?.email &&
      !!a.financierSignatory?.mobile &&
      !!a.financierSignatory?.address &&
      !!a.financierSignatory?.signingMethod &&
      !!a.itarangSignatory1?.name &&
      !!a.itarangSignatory1?.designation &&
      !!a.itarangSignatory1?.email &&
      !!a.itarangSignatory1?.mobile &&
      !!a.itarangSignatory1?.signingMethod &&
      !!a.itarangSignatory2?.name &&
      !!a.itarangSignatory2?.designation &&
      !!a.itarangSignatory2?.email &&
      !!a.itarangSignatory2?.mobile &&
      !!a.itarangSignatory2?.signingMethod;

    if (!coreRequired) return false;

    if (a.includeWitnessesInSigning) {
      return (
        !!a.witness1?.name &&
        !!a.witness1?.designation &&
        !!a.witness1?.email &&
        !!a.witness1?.mobile &&
        !!a.witness1?.address &&
        !!a.witness1?.signingMethod &&
        !!a.witness2?.name &&
        !!a.witness2?.designation &&
        !!a.witness2?.email &&
        !!a.witness2?.mobile &&
        !!a.witness2?.address &&
        !!a.witness2?.signingMethod
      );
    }

    return true;
  }, [agreement]);

  const handleGenerateViaDigio = async () => {
    try {
      setCreating(true);

      const currentState = useOnboardingStore.getState();

      const response = await fetch("/api/integrations/digio/create-agreement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentState),
      });

      let json: any = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }

      console.log("DIGIO FRONTEND -> RESPONSE:", json);

      if (!response.ok || !json?.success) {
        const errorMessage =
          json?.message ||
          json?.raw?.message ||
          json?.raw?.error_msg ||
          (typeof json?.raw === "string" ? json.raw : "") ||
          "Failed to create Digio agreement";

        alert(errorMessage);
        return;
      }

      const signerUrls = Array.isArray(json?.data?.signerUrls)
        ? json.data.signerUrls
        : [];

      setField("agreement", "provider", "Digio");
      setField("agreement", "templateSource", "Server Generated Agreement");
      setField(
        "agreement",
        "providerDocumentId",
        json?.data?.providerDocumentId || ""
      );
      setField("agreement", "requestId", json?.data?.requestId || "");
      setField(
        "agreement",
        "providerSigningUrl",
        json?.data?.signingUrl || ""
      );
      setField(
        "agreement",
        "providerRawResponse",
        JSON.stringify(
          {
            signerUrls,
            rawResponse: json?.data?.rawResponse || "",
          },
          null,
          2
        )
      );
      setField(
        "agreement",
        "agreementStatus",
        (json?.data?.status || "sent_for_signature") as AgreementStatusType
      );
      setField("agreement", "generatedDate", new Date().toISOString());
      setField("agreement", "lastActionTimestamp", new Date().toISOString());
      setField("agreement", "completionStatus", "Sent for Signature");

      alert("Digio agreement created successfully.");
    } catch (error) {
      console.error("DIGIO GENERATE ERROR:", error);
      alert("Failed to create Digio agreement");
    } finally {
      setCreating(false);
    }
  };

  if (financeEnabled !== "yes") return null;

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-[#E3E8EF] bg-gradient-to-br from-white to-[#F7FAFD] p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-[#1F5C8F]">
              Dealer Finance Agreement
            </p>
            <h2 className="mt-2 text-2xl font-bold text-[#173F63] md:text-3xl">
              Digio Agreement
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-500 md:text-base">
              Review the signatory details, generate the agreement from your
              onboarding data, and share the signing links with the required
              parties.
            </p>
          </div>

          <div className="min-w-[280px] rounded-2xl border border-[#E3E8EF] bg-white p-4 shadow-sm">
            <div className="space-y-2 text-sm text-slate-600">
              <p>
                <span className="font-semibold text-slate-800">Provider:</span>{" "}
                {agreement.provider || "Digio"}
              </p>
              <p>
                <span className="font-semibold text-slate-800">
                  Template Source:
                </span>{" "}
                {agreement.templateSource || "Server Generated Agreement"}
              </p>
              <p>
                <span className="font-semibold text-slate-800">
                  Generated On:
                </span>{" "}
                {agreement.generatedDate
                  ? new Date(agreement.generatedDate).toLocaleString()
                  : "Not generated yet"}
              </p>
              <div className="pt-1">
                <StatusBadge status={agreement.agreementStatus} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <SectionCard
        title="Agreement Meta"
        subtitle="These values will be used while generating the agreement PDF on the server."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <InputField
            type="date"
            value={agreement.dateOfSigning}
            onChange={(value) => setField("agreement", "dateOfSigning", value)}
            placeholder="Date of signing"
          />
          <InputField
            type="number"
            value={agreement.expiryDays}
            onChange={(value) =>
              setField("agreement", "expiryDays", Number(value || 0))
            }
            placeholder="Expiry days"
          />
          <select
            value={agreement.sequenceMode}
            onChange={(e) =>
              setField(
                "agreement",
                "sequenceMode",
                e.target.value as SequenceMode
              )
            }
            className="w-full rounded-2xl border border-[#E3E8EF] bg-white px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            <option value="sequential">Sequential Signing</option>
            <option value="parallel">Parallel Signing</option>
          </select>
        </div>
      </SectionCard>

      <SectionCard title="Dealer Signatory">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <select
            value={agreement.dealerSignerName}
            onChange={(e) => onDealerSignatoryChange(e.target.value)}
            className="w-full rounded-2xl border border-[#E3E8EF] bg-white px-4 py-3.5 focus:border-[#1F5C8F] focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            <option value="">Choose Dealer Signatory</option>
            {dealerSignatoryOptions.map((item) => (
              <option key={`${item.name}-${item.email}`} value={item.name}>
                {item.label}
              </option>
            ))}
          </select>

          <SelectField
            value={agreement.dealerSigningMethod as SigningMethod}
            onChange={(value) =>
              setField("agreement", "dealerSigningMethod", value)
            }
          />

          <InputField
            value={agreement.dealerSignerDesignation}
            onChange={() => undefined}
            placeholder="Designation"
            readOnly
          />
          <InputField
            value={agreement.dealerSignerEmail}
            onChange={() => undefined}
            placeholder="Email"
            readOnly
          />
          <InputField
            value={agreement.dealerSignerPhone}
            onChange={() => undefined}
            placeholder="Mobile"
            readOnly
          />
        </div>
      </SectionCard>

      <SectionCard title="iTarang Signatories">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <PartyCard title="iTarang Signatory 1">
            <InputField
              value={agreement.itarangSignatory1?.name}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...agreement.itarangSignatory1,
                  name: value,
                })
              }
              placeholder="Name"
            />
            <InputField
              value={agreement.itarangSignatory1?.designation}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...agreement.itarangSignatory1,
                  designation: value,
                })
              }
              placeholder="Designation"
            />
            <InputField
              value={agreement.itarangSignatory1?.email}
              onChange={(value) =>
                setField("agreement", "itarangSignatory1", {
                  ...agreement.itarangSignatory1,
                  email: value,
                })
              }
              placeholder="Email"
            />
            <InputField
              value={agreement.itarangSignatory1?.mobile}
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
                value={
                  (agreement.itarangSignatory1?.signingMethod ||
                    "") as SigningMethod
                }
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
              value={agreement.itarangSignatory2?.name}
              onChange={(value) =>
                setField("agreement", "itarangSignatory2", {
                  ...agreement.itarangSignatory2,
                  name: value,
                })
              }
              placeholder="Name"
            />
            <InputField
              value={agreement.itarangSignatory2?.designation}
              onChange={(value) =>
                setField("agreement", "itarangSignatory2", {
                  ...agreement.itarangSignatory2,
                  designation: value,
                })
              }
              placeholder="Designation"
            />
            <InputField
              value={agreement.itarangSignatory2?.email}
              onChange={(value) =>
                setField("agreement", "itarangSignatory2", {
                  ...agreement.itarangSignatory2,
                  email: value,
                })
              }
              placeholder="Email"
            />
            <InputField
              value={agreement.itarangSignatory2?.mobile}
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
                value={
                  (agreement.itarangSignatory2?.signingMethod ||
                    "") as SigningMethod
                }
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

      <SectionCard title="Financier">
        <div className="mb-4">
          <InputField
            value={agreement.financierName}
            onChange={(value) => setField("agreement", "financierName", value)}
            placeholder="Financier name"
          />
        </div>

        <PartyCard title="Financier Signatory">
          <InputField
            value={agreement.financierSignatory?.name}
            onChange={(value) =>
              setField("agreement", "financierSignatory", {
                ...agreement.financierSignatory,
                name: value,
              })
            }
            placeholder="Name"
          />
          <InputField
            value={agreement.financierSignatory?.designation || ""}
            onChange={(value) =>
              setField("agreement", "financierSignatory", {
                ...agreement.financierSignatory,
                designation: value,
              })
            }
            placeholder="Designation"
          />
          <InputField
            value={agreement.financierSignatory?.email}
            onChange={(value) =>
              setField("agreement", "financierSignatory", {
                ...agreement.financierSignatory,
                email: value,
              })
            }
            placeholder="Email"
          />
          <InputField
            value={agreement.financierSignatory?.mobile}
            onChange={(value) =>
              setField("agreement", "financierSignatory", {
                ...agreement.financierSignatory,
                mobile: value.replace(/[^0-9]/g, ""),
              })
            }
            placeholder="Mobile"
          />
          <InputField
            value={agreement.financierSignatory?.address}
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
              value={
                (agreement.financierSignatory?.signingMethod ||
                  "") as SigningMethod
              }
              onChange={(value) =>
                setField("agreement", "financierSignatory", {
                  ...agreement.financierSignatory,
                  signingMethod: value,
                })
              }
            />
          </div>
        </PartyCard>
      </SectionCard>

      <SectionCard
        title="Witnesses"
        subtitle="Enable only if your Digio workflow requires witness signing."
      >
        <label className="mb-4 flex items-center gap-3 text-sm font-medium text-[#173F63]">
          <input
            type="checkbox"
            checked={!!agreement.includeWitnessesInSigning}
            onChange={(e) =>
              setField(
                "agreement",
                "includeWitnessesInSigning",
                e.target.checked
              )
            }
          />
          Include witnesses in signing workflow
        </label>

        {agreement.includeWitnessesInSigning ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <PartyCard title="Witness 1">
              <InputField
                value={agreement.witness1?.name}
                onChange={(value) =>
                  setField("agreement", "witness1", {
                    ...agreement.witness1,
                    name: value,
                  })
                }
                placeholder="Name"
              />
              <InputField
                value={agreement.witness1?.designation || ""}
                onChange={(value) =>
                  setField("agreement", "witness1", {
                    ...agreement.witness1,
                    designation: value,
                  })
                }
                placeholder="Designation"
              />
              <InputField
                value={agreement.witness1?.email}
                onChange={(value) =>
                  setField("agreement", "witness1", {
                    ...agreement.witness1,
                    email: value,
                  })
                }
                placeholder="Email"
              />
              <InputField
                value={agreement.witness1?.mobile}
                onChange={(value) =>
                  setField("agreement", "witness1", {
                    ...agreement.witness1,
                    mobile: value.replace(/[^0-9]/g, ""),
                  })
                }
                placeholder="Mobile"
              />
              <InputField
                value={agreement.witness1?.address}
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
                  value={
                    (agreement.witness1?.signingMethod || "") as SigningMethod
                  }
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
                value={agreement.witness2?.name}
                onChange={(value) =>
                  setField("agreement", "witness2", {
                    ...agreement.witness2,
                    name: value,
                  })
                }
                placeholder="Name"
              />
              <InputField
                value={agreement.witness2?.designation || ""}
                onChange={(value) =>
                  setField("agreement", "witness2", {
                    ...agreement.witness2,
                    designation: value,
                  })
                }
                placeholder="Designation"
              />
              <InputField
                value={agreement.witness2?.email}
                onChange={(value) =>
                  setField("agreement", "witness2", {
                    ...agreement.witness2,
                    email: value,
                  })
                }
                placeholder="Email"
              />
              <InputField
                value={agreement.witness2?.mobile}
                onChange={(value) =>
                  setField("agreement", "witness2", {
                    ...agreement.witness2,
                    mobile: value.replace(/[^0-9]/g, ""),
                  })
                }
                placeholder="Mobile"
              />
              <InputField
                value={agreement.witness2?.address}
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
                  value={
                    (agreement.witness2?.signingMethod || "") as SigningMethod
                  }
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
        ) : null}
      </SectionCard>

      <SectionCard
        title="Agreement Generation"
        subtitle="The agreement PDF will be generated automatically from the onboarding data. No manual upload is required."
      >
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
          The system will generate the agreement using the data entered in the
          onboarding form and send it to Digio for eSign.
        </div>
      </SectionCard>

      <SectionCard title="Digio Request Status">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Request ID
            </p>
            <p className="mt-1 text-sm font-medium text-slate-800">
              {agreement.requestId || "Pending"}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Provider Document ID
            </p>
            <p className="mt-1 text-sm font-medium text-slate-800">
              {agreement.providerDocumentId || "Pending"}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={creating || !canGenerateAgreement}
            onClick={handleGenerateViaDigio}
            className="inline-flex items-center gap-2 rounded-2xl bg-[#1F5C8F] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#17486f] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ShieldCheck className="h-4 w-4" />
            {creating ? "Generating..." : "Generate via Digio"}
          </button>

          <button
            type="button"
            onClick={resetAgreementState}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Reset Agreement State
          </button>

          {agreement.providerSigningUrl ? (
            <a
              href={agreement.providerSigningUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open Primary Signing Link
            </a>
          ) : null}
        </div>

        {signerLinks.length > 0 ? (
          <div className="mt-6 space-y-3">
            <h4 className="text-sm font-semibold text-slate-800">
              All Signing Links
            </h4>

            {signerLinks.map((item: SignerUrlItem, index: number) => (
              <div
                key={`${item.identifier}-${index}`}
                className="rounded-2xl border border-slate-200 p-4"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">
                      {item.name || "Signer"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {item.reason} • {item.identifier}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      Status: {item.status || "requested"}
                    </p>
                  </div>

                  <a
                    href={item.authenticationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open Link
                  </a>
                </div>
              </div>
            ))}
          </div>
        ) : null}
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
          onClick={nextStep}
          className="inline-flex items-center gap-2 rounded-2xl bg-[#173F63] px-5 py-3 text-sm font-semibold text-white hover:bg-[#12324f]"
        >
          <CheckCircle2 className="h-4 w-4" />
          Continue
        </button>
      </div>
    </div>
  );
}