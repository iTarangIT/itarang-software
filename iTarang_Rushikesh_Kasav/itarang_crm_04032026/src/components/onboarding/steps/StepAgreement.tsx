"use client";

import { useMemo, useState } from "react";
import {
  FileText,
  Send,
  CheckCircle2,
  ShieldCheck,
  Eye,
  Download,
  RefreshCcw,
  Stamp,
  X,
} from "lucide-react";
import { useOnboardingStore } from "@/store/onboardingStore";
import FileUploadCard from "../FileUploadCard";

const STATUS_OPTIONS = [
  { key: "not_generated", label: "Not Generated", classes: "bg-slate-100 text-slate-700 border-slate-200" },
  { key: "draft_generated", label: "Draft Generated", classes: "bg-blue-100 text-blue-700 border-blue-200" },
  { key: "sent_for_signature", label: "Sent for Signature", classes: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  { key: "viewed_by_dealer", label: "Viewed by Dealer", classes: "bg-amber-100 text-amber-700 border-amber-200" },
  { key: "signed_by_dealer", label: "Signed by Dealer", classes: "bg-green-100 text-green-700 border-green-200" },
  { key: "completed", label: "Completed", classes: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  { key: "failed", label: "Failed / Retry Required", classes: "bg-red-100 text-red-700 border-red-200" },
] as const;

const timelineSteps = [
  "Agreement Drafted",
  "Sent to Dealer",
  "Dealer Viewed",
  "Signature Completed",
  "eStamp Applied",
  "Final Agreement Archived",
];

// Put your real agreement file path here.
// If your agreement PDF/DOCX is in /public, use that path.
// Example:
// /agreements/tarang-dealer-agreement.pdf
const AGREEMENT_FILE_URL = "/agreements/Tarang-Dealer-Agreement.pdf";

function StatusBadge({ status }: { status: string }) {
  const found = STATUS_OPTIONS.find((item) => item.key === status) || STATUS_OPTIONS[0];
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${found.classes}`}>
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
        <h3 className="text-lg md:text-xl font-bold text-[#173F63]">{title}</h3>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

function SignerCard({
  title,
  name,
  email,
  phone,
  method,
}: {
  title: string;
  name: string;
  email: string;
  phone: string;
  method: string;
}) {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-[#1F5C8F]" />
        <h4 className="text-base font-semibold text-[#173F63]">{title}</h4>
      </div>

      <div className="space-y-2 text-sm text-slate-600">
        <p><span className="font-medium text-slate-800">Signer Name:</span> {name || "Pending"}</p>
        <p><span className="font-medium text-slate-800">Email:</span> {email || "Pending"}</p>
        <p><span className="font-medium text-slate-800">Phone:</span> {phone || "Pending"}</p>
        <p><span className="font-medium text-slate-800">Signing Method:</span> {method || "Pending"}</p>
      </div>
    </div>
  );
}

function AgreementPreviewModal({
  open,
  onClose,
  fileUrl,
}: {
  open: boolean;
  onClose: () => void;
  fileUrl: string;
}) {
  if (!open) return null;

  const isPdf = fileUrl.toLowerCase().endsWith(".pdf");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-6xl rounded-3xl bg-white shadow-2xl border border-[#E3E8EF] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E3E8EF] px-5 py-4 bg-[#F9FBFD]">
          <div>
            <h3 className="text-lg font-bold text-[#173F63]">Dealer Agreement Preview</h3>
            <p className="text-sm text-slate-500">View, download, or close the agreement document</p>
          </div>

          <div className="flex items-center gap-3">
            <a
              href={fileUrl}
              download
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              Download
            </a>

            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-2 rounded-2xl bg-red-50 border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-100"
            >
              <X className="h-4 w-4" />
              Close
            </button>
          </div>
        </div>

        <div className="h-[75vh] bg-slate-50">
          {isPdf ? (
            <iframe
              src={fileUrl}
              title="Agreement Preview"
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
              <FileText className="h-12 w-12 text-[#1F5C8F]" />
              <div>
                <p className="text-base font-semibold text-slate-800">
                  Preview not supported for this file type in-browser
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  Please download the agreement document to view it.
                </p>
              </div>

              <a
                href={fileUrl}
                download
                className="inline-flex items-center gap-2 rounded-2xl bg-[#1F5C8F] px-5 py-3 text-sm font-semibold text-white hover:bg-[#173F63]"
              >
                <Download className="h-4 w-4" />
                Download Agreement
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function StepAgreement() {
  const [showAgreementPreview, setShowAgreementPreview] = useState(false);

  const financeEnabled = useOnboardingStore((s) => s.finance.enableFinance);
  const agreement = useOnboardingStore((s) => s.agreement);
  const errors = useOnboardingStore((s) => s.errors);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const setField = useOnboardingStore((s) => s.setField);
  const setUpload = useOnboardingStore((s) => s.setUpload);

  if (financeEnabled !== "yes") {
    return null;
  }

  const activeTimelineIndex = useMemo(() => {
    switch (agreement.agreementStatus) {
      case "not_generated":
        return 0;
      case "draft_generated":
        return 1;
      case "sent_for_signature":
        return 2;
      case "viewed_by_dealer":
        return 3;
      case "signed_by_dealer":
        return 4;
      case "completed":
        return 5;
      case "failed":
        return 1;
      default:
        return 0;
    }
  }, [agreement.agreementStatus]);

  const generateAgreement = () => {
    const now = new Date().toISOString();
    setField("agreement", "generatedDate", new Date().toLocaleDateString());
    setField("agreement", "requestId", `AGR-${Date.now()}`);
    setField("agreement", "lastActionTimestamp", now);
    setField("agreement", "completionStatus", "Draft Generated");
    setField("agreement", "agreementStatus", "draft_generated");

    setField("agreement", "dealerSignerName", agreement.authorizedSignatoryName);
    setField("agreement", "dealerSignerEmail", agreement.authorizedSignatoryEmail);
    setField("agreement", "dealerSignerPhone", agreement.authorizedSignatoryPhone);
  };

  const markSent = () => {
    setField("agreement", "agreementStatus", "sent_for_signature");
    setField("agreement", "lastActionTimestamp", new Date().toISOString());
    setField("agreement", "completionStatus", "Sent for Signature");
  };

  const markViewed = () => {
    setField("agreement", "agreementStatus", "viewed_by_dealer");
    setField("agreement", "lastActionTimestamp", new Date().toISOString());
    setField("agreement", "completionStatus", "Viewed by Dealer");
  };

  const markSigned = () => {
    setField("agreement", "agreementStatus", "signed_by_dealer");
    setField("agreement", "signedAt", new Date().toISOString());
    setField("agreement", "lastActionTimestamp", new Date().toISOString());
    setField("agreement", "completionStatus", "Signed by Dealer");
    setField("agreement", "stampStatus", "eSign completed");
  };

  const markCompleted = () => {
    setField("agreement", "agreementStatus", "completed");
    setField("agreement", "lastActionTimestamp", new Date().toISOString());
    setField("agreement", "completionStatus", "Completed");
    setField("agreement", "stampStatus", "eStamp applied / archived");
  };

  return (
    <>
      <AgreementPreviewModal
        open={showAgreementPreview}
        onClose={() => setShowAgreementPreview(false)}
        fileUrl={AGREEMENT_FILE_URL}
      />

      <div className="space-y-6">
        <div className="rounded-3xl border border-[#E3E8EF] bg-gradient-to-br from-white to-[#F7FAFD] p-6 md:p-8 shadow-sm">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-[#1F5C8F]">
                Dealer Finance Agreement
              </p>
              <h2 className="mt-2 text-2xl md:text-3xl font-bold text-[#173F63]">
                Modern contract execution workflow
              </h2>
              <p className="mt-2 max-w-3xl text-sm md:text-base text-slate-500">
                Use Signzy-based agreement execution for eSign, digital workflows, and stamp-enabled
                contract completion.
              </p>
            </div>

            <div className="rounded-2xl border border-[#E3E8EF] bg-white p-4 min-w-[280px] shadow-sm">
              <div className="space-y-2 text-sm text-slate-600">
                <p><span className="font-semibold text-slate-800">Agreement Name:</span> {agreement.agreementName}</p>
                <p><span className="font-semibold text-slate-800">Template Source:</span> {agreement.templateSource}</p>
                <p><span className="font-semibold text-slate-800">Provider:</span> {agreement.provider}</p>
                <p><span className="font-semibold text-slate-800">Agreement Version:</span> {agreement.agreementVersion}</p>
                <p><span className="font-semibold text-slate-800">Date Generated:</span> {agreement.generatedDate || "Not generated yet"}</p>
              </div>

              <div className="mt-4">
                <StatusBadge status={agreement.agreementStatus} />
              </div>
            </div>
          </div>
        </div>

        <SectionCard
          title="A. Agreement Generation"
          subtitle="Prepare the dealer agreement using the approved iTarang legal template and signer details."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <input
                value={agreement.selectedTemplate}
                onChange={(e) => setField("agreement", "selectedTemplate", e.target.value)}
                placeholder="Agreement template selected"
                className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
              />
              {errors.selectedTemplate && <p className="mt-2 text-sm text-red-600">{errors.selectedTemplate}</p>}
            </div>

            <div>
              <input
                value={agreement.dealerLegalEntityName}
                onChange={(e) => setField("agreement", "dealerLegalEntityName", e.target.value)}
                placeholder="Dealer legal entity name"
                className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
              />
              {errors.dealerLegalEntityName && <p className="mt-2 text-sm text-red-600">{errors.dealerLegalEntityName}</p>}
            </div>

            <div>
              <input
                value={agreement.authorizedSignatoryName}
                onChange={(e) => setField("agreement", "authorizedSignatoryName", e.target.value)}
                placeholder="Authorized signatory name"
                className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
              />
              {errors.authorizedSignatoryName && <p className="mt-2 text-sm text-red-600">{errors.authorizedSignatoryName}</p>}
            </div>

            <div>
              <input
                value={agreement.authorizedSignatoryEmail}
                onChange={(e) => setField("agreement", "authorizedSignatoryEmail", e.target.value)}
                placeholder="Authorized signatory email"
                className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
              />
              {errors.authorizedSignatoryEmail && <p className="mt-2 text-sm text-red-600">{errors.authorizedSignatoryEmail}</p>}
            </div>

            <div>
              <input
                value={agreement.authorizedSignatoryPhone}
                onChange={(e) => setField("agreement", "authorizedSignatoryPhone", e.target.value)}
                placeholder="Authorized signatory phone"
                className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
              />
              {errors.authorizedSignatoryPhone && <p className="mt-2 text-sm text-red-600">{errors.authorizedSignatoryPhone}</p>}
            </div>

            <div>
              <input
                value={agreement.stampDutyState}
                onChange={(e) => setField("agreement", "stampDutyState", e.target.value)}
                placeholder="Stamp duty state / jurisdiction"
                className="w-full rounded-2xl border border-[#E3E8EF] px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#1F5C8F]"
              />
              {errors.stampDutyState && <p className="mt-2 text-sm text-red-600">{errors.stampDutyState}</p>}
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 xl:grid-cols-2 gap-6">
            <FileUploadCard
              label="Agreement Template File"
              hint="Upload approved DOC/PDF converted reference if needed"
              value={agreement.agreementTemplateFile}
              onChange={(item) => setUpload("agreement.agreementTemplateFile", item)}
            />

            <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-5">
              <h4 className="text-base font-semibold text-[#173F63] mb-3">Template Reference</h4>
              <p className="text-sm text-slate-600">
                Use your uploaded dealer agreement as the base legal reference for generation and dealer execution.
              </p>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setShowAgreementPreview(true)}
                  className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Eye className="h-4 w-4" />
                  Agreement Preview
                </button>

                <a
                  href={AGREEMENT_FILE_URL}
                  download
                  className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Download className="h-4 w-4" />
                  Download Agreement
                </a>

                <button
                  type="button"
                  onClick={generateAgreement}
                  className="inline-flex items-center gap-2 rounded-2xl bg-[#1F5C8F] px-5 py-3 text-sm font-semibold text-white hover:bg-[#173F63]"
                >
                  <FileText className="h-4 w-4" />
                  Generate Agreement
                </button>
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="B. Signer Details"
          subtitle="Track all signer identities and digital execution methods."
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <SignerCard
              title="Dealer"
              name={agreement.dealerSignerName}
              email={agreement.dealerSignerEmail}
              phone={agreement.dealerSignerPhone}
              method={agreement.dealerSigningMethod}
            />

            <SignerCard
              title="Sales Manager"
              name={agreement.salesManagerName}
              email={agreement.salesManagerEmail}
              phone={agreement.salesManagerPhone}
              method={agreement.salesManagerSigningMethod}
            />

            <SignerCard
              title="Business Head"
              name={agreement.businessHeadName}
              email={agreement.businessHeadEmail}
              phone={agreement.businessHeadPhone}
              method={agreement.businessHeadSigningMethod}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="C. Contract Status Timeline"
          subtitle="Visual timeline of contract execution and archival."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4">
            {timelineSteps.map((step, index) => {
              const active = index <= activeTimelineIndex;

              return (
                <div
                  key={step}
                  className={`rounded-2xl border p-4 transition-all ${
                    active
                      ? "border-[#1F5C8F] bg-blue-50"
                      : "border-[#E3E8EF] bg-white"
                  }`}
                >
                  <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ${
                    active ? "bg-[#1F5C8F] text-white" : "bg-slate-200 text-slate-500"
                  }`}>
                    {index + 1}
                  </div>
                  <p className="text-sm font-medium text-slate-700">{step}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={markSent}
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Send className="h-4 w-4" />
              Mark Sent
            </button>

            <button
              type="button"
              onClick={markViewed}
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Eye className="h-4 w-4" />
              Mark Viewed
            </button>

            <button
              type="button"
              onClick={markSigned}
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <CheckCircle2 className="h-4 w-4" />
              Mark Signed
            </button>

            <button
              type="button"
              onClick={markCompleted}
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Stamp className="h-4 w-4" />
              Mark Completed
            </button>
          </div>
        </SectionCard>

        <SectionCard
          title="D. Agreement Document Panel"
          subtitle="Manage draft, signed copy, template replacement, and dealer reference documents."
        >
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setShowAgreementPreview(true)}
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Eye className="h-4 w-4" />
              Preview Agreement
            </button>

            <a
              href={AGREEMENT_FILE_URL}
              download
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              Download Draft
            </a>

            <button
              type="button"
              onClick={() => setShowAgreementPreview(true)}
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Eye className="h-4 w-4" />
              View Signed Copy
            </button>

            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <RefreshCcw className="h-4 w-4" />
              Replace Template
            </button>

            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Send className="h-4 w-4" />
              Resend for Signature
            </button>
          </div>

          <div className="mt-6">
            <FileUploadCard
              label="Dealer Signed Agreement Upload"
              hint="After dealer downloads and signs, upload signed PDF/image here for record"
              value={agreement.signedAgreementFile}
              onChange={(item) => setUpload("agreement.signedAgreementFile", item)}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="E. Audit & Tracking"
          subtitle="Audit-ready contract completion details for CRM visibility and admin tracking."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Request ID</p>
              <p className="mt-2 text-sm font-semibold text-slate-800">{agreement.requestId || "Pending"}</p>
            </div>

            <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Last action timestamp</p>
              <p className="mt-2 text-sm font-semibold text-slate-800">
                {agreement.lastActionTimestamp
                  ? new Date(agreement.lastActionTimestamp).toLocaleString()
                  : "Pending"}
              </p>
            </div>

            <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Signed at</p>
              <p className="mt-2 text-sm font-semibold text-slate-800">
                {agreement.signedAt ? new Date(agreement.signedAt).toLocaleString() : "Pending"}
              </p>
            </div>

            <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Stamp status</p>
              <p className="mt-2 text-sm font-semibold text-slate-800">{agreement.stampStatus || "Pending"}</p>
            </div>

            <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Completion status</p>
              <p className="mt-2 text-sm font-semibold text-slate-800">{agreement.completionStatus || "Pending"}</p>
            </div>

            <div className="rounded-2xl border border-[#E3E8EF] bg-[#FBFDFF] p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Agreement status</p>
              <div className="mt-2">
                <StatusBadge status={agreement.agreementStatus} />
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-[#E3E8EF] bg-[#F9FBFD] p-4 text-sm text-slate-600">
            Use Signzy-based agreement execution for eSign, digital workflows, and stamp-enabled contract completion.
          </div>
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
            className="inline-flex items-center justify-center rounded-2xl bg-[#1F5C8F] px-6 py-3 text-sm font-semibold text-white hover:bg-[#173F63]"
          >
            Next →
          </button>
        </div>
      </div>
    </>
  );
}
