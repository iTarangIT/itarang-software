"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Building2,
  FileText,
  Landmark,
  ShieldCheck,
  Eye,
  X,
  Download,
  Image as ImageIcon,
} from "lucide-react";
import { useOnboardingStore } from "@/store/onboardingStore";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

function ReviewCard({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-[#E3E8EF] bg-white shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-[#E3E8EF] px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            {icon ? <span className="text-[#1F5C8F]">{icon}</span> : null}
            <h3 className="text-lg font-semibold text-[#173F63]">{title}</h3>
          </div>
          {subtitle ? (
            <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
          ) : null}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

type PreviewDoc = {
  label: string;
  fileName: string;
  url: string;
  isImage: boolean;
  isPdf: boolean;
};

function resolveDocUrl(item: UploadItemLike) {
  if (!item) return null;
  return item.uploadedUrl || (item as any).previewUrl || null;
}

function inferKindFromUrl(url: string, fileName?: string) {
  const lower = (url + " " + (fileName || "")).toLowerCase();
  const isPdf = /\.pdf(\?|$)/.test(lower) || lower.includes("application/pdf");
  const isImage =
    !isPdf &&
    (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/.test(lower) || lower.startsWith("blob:") || lower.startsWith("data:image/"));
  return { isPdf, isImage };
}

function DocumentTile({
  label,
  item,
  onOpen,
}: {
  label: string;
  item: UploadItemLike;
  onOpen: (doc: PreviewDoc) => void;
}) {
  const url = resolveDocUrl(item);
  const fileName = item?.file?.name || "";
  const uploaded = Boolean(url);

  if (!uploaded) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-dashed border-[#E3E8EF] bg-white/70 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </p>
        <p className="mt-2 text-sm font-medium text-slate-400">Not uploaded</p>
      </div>
    );
  }

  const { isPdf, isImage } = inferKindFromUrl(url!, fileName);

  return (
    <button
      type="button"
      onClick={() =>
        onOpen({
          label,
          fileName: fileName || label,
          url: url!,
          isImage,
          isPdf,
        })
      }
      className="group relative overflow-hidden rounded-2xl border border-[#E3E8EF] bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#1F5C8F]/60 hover:shadow-md"
    >
      {/* Gradient accent bar */}
      <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#1F5C8F] via-sky-400 to-emerald-400 opacity-80" />

      <div className="flex items-start gap-3">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
            isPdf
              ? "bg-red-50 text-red-500"
              : isImage
              ? "bg-emerald-50 text-emerald-600"
              : "bg-[#F4F8FC] text-[#1F5C8F]"
          }`}
        >
          {isPdf ? (
            <FileText className="h-5 w-5" />
          ) : isImage ? (
            <ImageIcon className="h-5 w-5" />
          ) : (
            <FileText className="h-5 w-5" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {label}
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-800">
            {fileName || "Uploaded file"}
          </p>
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-[#1F5C8F] opacity-80 group-hover:opacity-100">
            <Eye className="h-3.5 w-3.5" />
            Click to preview
          </p>
        </div>
      </div>
    </button>
  );
}

function DocumentPreviewModal({
  doc,
  onClose,
}: {
  doc: PreviewDoc | null;
  onClose: () => void;
}) {
  if (!doc) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/70 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-white/20"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 bg-gradient-to-r from-[#173F63] via-[#1F5C8F] to-sky-500 px-6 py-4 text-white">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15">
              {doc.isPdf ? (
                <FileText className="h-5 w-5" />
              ) : doc.isImage ? (
                <ImageIcon className="h-5 w-5" />
              ) : (
                <FileText className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.2em] text-white/70">
                {doc.label}
              </p>
              <p className="truncate text-base font-semibold">{doc.fileName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={doc.url}
              download={doc.fileName}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur transition hover:bg-white/25"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 text-white transition hover:bg-white/25"
              aria-label="Close preview"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto bg-slate-50">
          {doc.isImage ? (
            <div className="flex h-full items-center justify-center p-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={doc.url}
                alt={doc.fileName}
                className="max-h-[75vh] max-w-full rounded-2xl object-contain shadow-lg ring-1 ring-slate-200"
              />
            </div>
          ) : doc.isPdf ? (
            <iframe
              src={doc.url}
              title={doc.fileName}
              className="h-[75vh] w-full border-0"
            />
          ) : (
            <div className="flex h-[40vh] flex-col items-center justify-center gap-3 p-6 text-slate-500">
              <FileText className="h-10 w-10 text-slate-400" />
              <p className="text-sm">
                Inline preview is not available for this file type. Use the
                Download button above to save a copy.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-[#FAFBFC] px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-medium text-slate-800">{value || "—"}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string | undefined }) {
  const safeStatus = (status || "not_generated").toLowerCase();

  const map: Record<string, string> = {
    not_generated: "bg-slate-100 text-slate-700 border-slate-200",
    draft_ready: "bg-slate-100 text-slate-700 border-slate-200",
    sent_for_signature: "bg-indigo-100 text-indigo-700 border-indigo-200",
    viewed: "bg-amber-100 text-amber-700 border-amber-200",
    partially_signed: "bg-blue-100 text-blue-700 border-blue-200",
    completed: "bg-emerald-100 text-emerald-700 border-emerald-200",
    failed: "bg-red-100 text-red-700 border-red-200",
    expired: "bg-orange-100 text-orange-700 border-orange-200",
  };

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${map[safeStatus] || map.not_generated
        }`}
    >
      {safeStatus.replaceAll("_", " ")}
    </span>
  );
}

type UploadItemLike = {
  file?: File | null;
  uploadedUrl?: string | null;
  storagePath?: string | null;
  bucketName?: string | null;
} | null | undefined;

type DealerDocumentPayload = {
  documentType: string;
  bucketName: string;
  storagePath: string;
  fileName: string;
  fileUrl: string | null;
  mimeType: string | null;
  fileSize: number | null;
};

function buildDocument(
  documentType: string,
  item: UploadItemLike
): DealerDocumentPayload | null {
  if (!item?.file || !item?.storagePath) {
    return null;
  }

  return {
    documentType,
    bucketName: item.bucketName || "dealer-documents",
    storagePath: item.storagePath,
    fileName: item.file.name,
    fileUrl: item.uploadedUrl || null,
    mimeType: item.file.type || null,
    fileSize: typeof item.file.size === "number" ? item.file.size : null,
  };
}

function getPrimaryContact(
  state: ReturnType<typeof useOnboardingStore.getState>
) {
  const companyType = state.company?.companyType;

  if (companyType === "sole_proprietorship") {
    return {
      ownerName: state.ownership?.ownerName || "",
      ownerPhone: state.ownership?.ownerPhone || "",
      ownerLandline: state.ownership?.ownerLandline || "",
      ownerEmail: state.ownership?.ownerEmail || "",
    };
  }

  if (companyType === "partnership_firm") {
    const firstPartner = state.ownership?.partners?.[0];
    return {
      ownerName: (firstPartner as any)?.name || "",
      ownerPhone: (firstPartner as any)?.phone || "",
      ownerLandline: (firstPartner as any)?.landline || "",
      ownerEmail: (firstPartner as any)?.email || "",
    };
  }

  if (companyType === "private_limited_firm") {
    const firstDirector = state.ownership?.directors?.[0];
    return {
      ownerName: (firstDirector as any)?.name || "",
      ownerPhone: (firstDirector as any)?.phone || "",
      ownerLandline: (firstDirector as any)?.landline || "",
      ownerEmail: (firstDirector as any)?.email || "",
    };
  }

  return {
    ownerName: state.ownership?.ownerName || "",
    ownerPhone: state.ownership?.ownerPhone || "",
    ownerLandline: state.ownership?.ownerLandline || "",
    ownerEmail: state.ownership?.ownerEmail || "",
  };
}

export default function StepReview() {
  const supabase = createClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<PreviewDoc | null>(null);
  const router = useRouter();

  const state = useOnboardingStore();
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const setField = useOnboardingStore((s) => s.setField);
  const errors = useOnboardingStore((s) => s.errors);
  const setErrors = useOnboardingStore((s) => s.setErrors);
  const completeOnboarding = useOnboardingStore((s) => s.completeOnboarding);

  const primaryContact = getPrimaryContact(state);

  const agreementRequired = state.finance?.enableFinance === "yes";
  const agreementAlreadyCompleted =
    !agreementRequired || state.agreement?.agreementStatus === "completed";

  const signerFlow = useMemo(
    () => [
      {
        order: 1,
        title: "Dealer Signatory",
        name: state.agreement?.dealerSignerName || "Pending",
      },
      {
        order: 2,
        title: "iTarang Signatory 1",
        name: state.agreement?.itarangSignatory1?.name || "Pending",
      },
      ...(state.agreement?.itarangSignatory2?.name?.trim()
        ? [{ order: 3, title: "iTarang Signatory 2", name: state.agreement.itarangSignatory2.name }]
        : []),
    ],
    [state.agreement]
  );

  const handleSubmitApplication = async () => {
    const submitErrors: Record<string, string> = {};

    if (!state.reviewChecks.confirmInfo) {
      submitErrors.confirmInfo = "Please confirm all information is correct";
    }
    if (!state.reviewChecks.confirmDocs) {
      submitErrors.confirmDocs = "Please confirm uploaded documents are valid";
    }
    if (!state.reviewChecks.agreeTerms) {
      submitErrors.agreeTerms =
        "Please agree to iTarang onboarding and dealer terms";
    }

    const documents = [
      buildDocument("itr_3_years", state.compliance?.itr3Years),
      buildDocument(
        "bank_statement_3_months",
        state.compliance?.bankStatement3Months
      ),
      buildDocument("undated_cheques", state.compliance?.undatedCheques),
      buildDocument("passport_photo", state.compliance?.passportPhoto),
      buildDocument("udyam_certificate", state.compliance?.udyamCertificate),
      buildDocument("gst_certificate", state.company?.gstCertificate),
      buildDocument("pan_card", state.company?.companyPanFile),
    ].filter((doc): doc is DealerDocumentPayload => doc !== null);

    if (documents.length === 0) {
      submitErrors.documents =
        "Please upload at least one valid document before submitting";
    }

    if (!primaryContact.ownerName) {
      submitErrors.ownerName =
        "Primary contact name is required before submission";
    }
    if (!primaryContact.ownerPhone) {
      submitErrors.ownerPhone =
        "Primary contact phone is required before submission";
    }
    if (!primaryContact.ownerEmail) {
      submitErrors.ownerEmail =
        "Primary contact email is required before submission";
    }

    if (Object.keys(submitErrors).length > 0) {
      setErrors(submitErrors);
      return;
    }

    try {
      setIsSubmitting(true);

      const payload = {
        applicationId: "",
        dealerId: state.dealerId || "",
        company: state.company,
        compliance: state.compliance,
        ownership: state.ownership,
        finance: state.finance,
        reviewChecks: state.reviewChecks,

        // Keep the flat payload while the backend submit flow is being unified.
        companyName: state.company?.companyName || "",
        companyType: state.company?.companyType || "",
        gstNumber: state.company?.gstNumber || "",
        panNumber: state.company?.companyPanNumber || "",
        businessAddress: {
          address: state.company?.companyAddress || "",
        },
        registeredAddress: {
          address: state.company?.companyAddress || "",
        },
        financeEnabled: state.finance?.enableFinance === "yes",
        onboardingStatus: "submitted",
        reviewStatus: "pending_admin_review",

        ownerName: primaryContact.ownerName,
        ownerPhone: primaryContact.ownerPhone,
        ownerLandline: primaryContact.ownerLandline,
        ownerEmail: primaryContact.ownerEmail,

        bankName: state.ownership?.bankName || "",
        accountNumber: state.ownership?.accountNumber || "",
        beneficiaryName: state.ownership?.beneficiaryName || "",
        ifscCode: state.ownership?.ifsc || "",
        documents,

        agreement: agreementRequired
          ? {
            provider: state.agreement?.provider || "Digio",
            agreementName: state.agreement?.agreementName || "",
            agreementVersion: state.agreement?.agreementVersion || "",
            agreementStatus:
              state.agreement?.agreementStatus || "not_generated",
            requestId: state.agreement?.requestId || "",
            providerDocumentId: state.agreement?.providerDocumentId || "",
            providerSigningUrl: state.agreement?.providerSigningUrl || "",
            generatedDate: state.agreement?.generatedDate || "",
            signedAt: state.agreement?.signedAt || "",
            completionStatus: state.agreement?.completionStatus || "",
            stampStatus: state.agreement?.stampStatus || "",
            dateOfSigning: state.agreement?.dateOfSigning || "",
            mouDate: state.agreement?.mouDate || "",
            financierName: state.agreement?.financierName || "",
            isOemFinancing: !!state.agreement?.isOemFinancing,
            vehicleType: state.agreement?.vehicleType || "",
            manufacturer: state.agreement?.manufacturer || "",
            brand: state.agreement?.brand || "",
            statePresence: state.agreement?.statePresence || "",
            dealerSignerName: state.agreement?.dealerSignerName || "",
            dealerSignerDesignation:
              state.agreement?.dealerSignerDesignation || "",
            dealerSignerEmail: state.agreement?.dealerSignerEmail || "",
            dealerSignerPhone: state.agreement?.dealerSignerPhone || "",
            dealerSigningMethod: state.agreement?.dealerSigningMethod || "",
            financierSignatory:
              state.agreement?.financierSignatory || null,
            // Sales manager details are captured in StepAgreement when finance
            // is enabled. They must be forwarded to the submit route so the
            // admin queue / detail view can show them; otherwise the DB row
            // keeps NULLs and the UI renders "Not available".
            salesManager: state.agreement?.salesManager || null,
            itarangSignatory1: state.agreement?.itarangSignatory1 || null,
            itarangSignatory2: state.agreement?.itarangSignatory2 || null,
            signingOrder: (() => {
              const hasFinancier = !!state.agreement?.financierSignatory?.name?.trim();
              const hasItarang2 = !!state.agreement?.itarangSignatory2?.name?.trim();
              const order: string[] = ["dealer"];
              if (hasFinancier) order.push("financier");
              order.push("itarang_1");
              if (hasItarang2) order.push("itarang_2");
              return order;
            })(),
          }
          : {
            // Finance disabled: no Digio agreement, but the dealer still
            // captures sales-manager info in StepFinance. Pass it through so
            // the submit route can persist it to the columns the admin UI
            // reads.
            salesManager: state.agreement?.salesManager || null,
          },
      };

      const response = await fetch("/api/dealer/onboarding/submit", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        setErrors({
          api:
            result.message ||
            "Failed to submit dealer onboarding application",
        });
        return;
      }

      // Mark onboarding complete in Zustand store (also saves dealerId to localStorage)
      completeOnboarding();

      // Always send submitted dealers to the sandbox login portal. A stale
      // ngrok URL in NEXT_PUBLIC_DEALER_LOGIN_URL / NEXT_PUBLIC_APP_URL must
      // not be able to override this — we ignore any value pointing at ngrok.
      const envOverride = process.env.NEXT_PUBLIC_DEALER_LOGIN_URL;
      const redirectUrl =
        envOverride && !/ngrok/i.test(envOverride)
          ? envOverride
          : "https://sandbox.itarang.com";

      // Sign out in the background; don't block redirect if network is slow
      supabase.auth.signOut().catch(() => { });

      // Prefer client-side navigation, but also force a hard redirect to clear state
      router.replace(redirectUrl);
      if (typeof window !== "undefined") {
        window.location.assign(redirectUrl);
      }
    } catch (error) {
      console.error("Dealer onboarding submission error:", error);
      setErrors({
        api:
          error instanceof Error
            ? error.message
            : "Something went wrong while submitting",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="rounded-3xl border border-[#E3E8EF] bg-gradient-to-br from-white to-[#F7FAFD] p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-[#1F5C8F]">
              Final Review
            </p>
            <h2 className="mt-2 text-2xl font-bold text-[#173F63] md:text-3xl">
              Review Dealer Application
            </h2>
            <p className="mt-2 text-sm text-slate-500 md:text-base">
              Review company, documents, finance enablement, and agreement
              details before final submission to admin.
            </p>
          </div>

          <div className="rounded-2xl border border-[#E3E8EF] bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-800">
                Agreement Required:
              </span>{" "}
              {agreementRequired ? "Yes" : "No"}
            </p>
            <div className="mt-2">
              <StatusBadge
                status={
                  agreementRequired
                    ? state.agreement?.agreementStatus
                    : "completed"
                }
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Agreement warning ── */}
      {agreementRequired && !agreementAlreadyCompleted && (
        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Agreement will be generated by the iTarang team after review. You
              will receive a notification once the agreement is ready for
              signing.
            </p>
          </div>
        </div>
      )}

      {/* ── Company Details ── */}
      <ReviewCard
        title="Company Details"
        subtitle="Business identity and registration details"
        icon={<Building2 className="h-5 w-5" />}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <InfoRow label="Company Name" value={state.company?.companyName} />
          <InfoRow label="Company Type" value={state.company?.companyType} />
          <InfoRow label="GST Number" value={state.company?.gstNumber} />
          <InfoRow label="PAN Number" value={state.company?.companyPanNumber} />
          <div className="md:col-span-2">
            <InfoRow label="Address" value={state.company?.companyAddress} />
          </div>
        </div>
      </ReviewCard>

      {/* ── Primary Contact ── */}
      <ReviewCard
        title="Primary Contact Details"
        subtitle="Main person mapped from ownership details"
        icon={<ShieldCheck className="h-5 w-5" />}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <InfoRow label="Name" value={primaryContact.ownerName} />
          <InfoRow label="Phone" value={primaryContact.ownerPhone} />
          <InfoRow label="Email" value={primaryContact.ownerEmail} />
        </div>
      </ReviewCard>

      {/* ── Ownership Details (address per company type) ── */}
      {state.company?.companyType === "sole_proprietorship" && (
        <ReviewCard
          title="Owner Details"
          subtitle="Owner identity and residential address"
          icon={<ShieldCheck className="h-5 w-5" />}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <InfoRow label="Owner Name" value={state.ownership?.ownerName} />
            <InfoRow label="Phone" value={state.ownership?.ownerPhone} />
            <InfoRow
              label="Landline"
              value={state.ownership?.ownerLandline || "—"}
            />
            <InfoRow label="Email" value={state.ownership?.ownerEmail} />
            <InfoRow
              label="Age"
              value={state.ownership?.ownerAge || "—"}
            />
            <div className="md:col-span-2">
              <InfoRow
                label="Address Line 1"
                value={state.ownership?.ownerAddressLine1}
              />
            </div>
            <InfoRow label="City" value={state.ownership?.ownerCity} />
            <InfoRow
              label="District"
              value={state.ownership?.ownerDistrict}
            />
            <InfoRow label="State" value={state.ownership?.ownerState} />
            <InfoRow
              label="Pin Code"
              value={state.ownership?.ownerPinCode}
            />
          </div>
        </ReviewCard>
      )}

      {state.company?.companyType === "partnership_firm" &&
        (state.ownership?.partners?.length || 0) > 0 && (
          <ReviewCard
            title="Partner Details"
            subtitle="Each partner's contact and residential address"
            icon={<ShieldCheck className="h-5 w-5" />}
          >
            <div className="space-y-4">
              {state.ownership.partners.map((partner: any, index: number) => (
                <div
                  key={partner?.id || index}
                  className="rounded-2xl border border-[#E3E8EF] bg-[#FAFBFC] p-4"
                >
                  <h4 className="mb-3 text-sm font-semibold text-[#173F63]">
                    Partner {index + 1}
                  </h4>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <InfoRow label="Name" value={partner?.name} />
                    <InfoRow label="Phone" value={partner?.phone} />
                    <InfoRow
                      label="Landline"
                      value={partner?.landline || "—"}
                    />
                    <InfoRow label="Email" value={partner?.email} />
                    <InfoRow label="Age" value={partner?.age || "—"} />
                    <div className="md:col-span-2">
                      <InfoRow
                        label="Address Line 1"
                        value={partner?.addressLine1}
                      />
                    </div>
                    <InfoRow label="City" value={partner?.city} />
                    <InfoRow label="District" value={partner?.district} />
                    <InfoRow label="State" value={partner?.state} />
                    <InfoRow label="Pin Code" value={partner?.pinCode} />
                  </div>
                </div>
              ))}
            </div>
          </ReviewCard>
        )}

      {state.company?.companyType === "private_limited_firm" &&
        (state.ownership?.directors?.length || 0) > 0 && (
          <ReviewCard
            title="Director Details"
            subtitle="Each director's contact and residential address"
            icon={<ShieldCheck className="h-5 w-5" />}
          >
            <div className="space-y-4">
              {state.ownership.directors.map((director: any, index: number) => (
                <div
                  key={director?.id || index}
                  className="rounded-2xl border border-[#E3E8EF] bg-[#FAFBFC] p-4"
                >
                  <h4 className="mb-3 text-sm font-semibold text-[#173F63]">
                    Director {index + 1}
                  </h4>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <InfoRow label="Name" value={director?.name} />
                    <InfoRow label="Phone" value={director?.phone} />
                    <InfoRow
                      label="Landline"
                      value={director?.landline || "—"}
                    />
                    <InfoRow label="Email" value={director?.email} />
                    <InfoRow label="Age" value={director?.age || "—"} />
                    <div className="md:col-span-2">
                      <InfoRow
                        label="Address Line 1"
                        value={director?.addressLine1}
                      />
                    </div>
                    <InfoRow label="City" value={director?.city} />
                    <InfoRow label="District" value={director?.district} />
                    <InfoRow label="State" value={director?.state} />
                    <InfoRow label="Pin Code" value={director?.pinCode} />
                  </div>
                </div>
              ))}
            </div>
          </ReviewCard>
        )}

      {/* ── Compliance Documents ── */}
      <ReviewCard
        title="Compliance Documents"
        subtitle="Click any tile to preview the document right here — no new tab"
        icon={<FileText className="h-5 w-5" />}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <DocumentTile
            label="GST Certificate"
            item={state.company?.gstCertificate as UploadItemLike}
            onOpen={setPreviewDoc}
          />
          <DocumentTile
            label="Company PAN"
            item={state.company?.companyPanFile as UploadItemLike}
            onOpen={setPreviewDoc}
          />
          <DocumentTile
            label="ITR (Last 3 Years)"
            item={state.compliance?.itr3Years as UploadItemLike}
            onOpen={setPreviewDoc}
          />
          <DocumentTile
            label="Bank Statement"
            item={state.compliance?.bankStatement3Months as UploadItemLike}
            onOpen={setPreviewDoc}
          />
          <DocumentTile
            label="Undated Cheques"
            item={state.compliance?.undatedCheques as UploadItemLike}
            onOpen={setPreviewDoc}
          />
          <DocumentTile
            label="Passport Photo"
            item={state.compliance?.passportPhoto as UploadItemLike}
            onOpen={setPreviewDoc}
          />
          <DocumentTile
            label="Udyam Certificate"
            item={state.compliance?.udyamCertificate as UploadItemLike}
            onOpen={setPreviewDoc}
          />
        </div>
      </ReviewCard>

      {/* ── Ownership & Banking ── */}
      <ReviewCard
        title="Ownership & Banking"
        subtitle="Bank account and beneficiary details"
        icon={<Landmark className="h-5 w-5" />}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <InfoRow label="Bank Name" value={state.ownership?.bankName} />
          <InfoRow
            label="Account Number"
            value={state.ownership?.accountNumber}
          />
          <InfoRow label="IFSC" value={state.ownership?.ifsc} />
          <InfoRow
            label="Beneficiary Name"
            value={state.ownership?.beneficiaryName}
          />
          <InfoRow label="Branch" value={state.ownership?.branch || "—"} />
          <InfoRow
            label="Account Type"
            value={
              state.ownership?.accountType
                ? state.ownership.accountType
                    .charAt(0)
                    .toUpperCase() +
                  state.ownership.accountType.slice(1)
                : "—"
            }
          />
        </div>
      </ReviewCard>

      {/* ── Finance Enablement ── */}
      <ReviewCard
        title="Finance Enablement"
        subtitle="Final finance selection from Step 4"
        icon={<CheckCircle2 className="h-5 w-5" />}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <InfoRow
            label="Finance Enabled"
            value={state.finance?.enableFinance === "yes" ? "Yes" : "No"}
          />
          <InfoRow
            label="Finance Contact Person"
            value={state.finance?.financeContactPerson || "—"}
          />
          <InfoRow
            label="Finance Contact Phone"
            value={state.finance?.financeContactPhone || "—"}
          />
          <InfoRow
            label="Finance Contact Email"
            value={state.finance?.financeContactEmail || "—"}
          />
        </div>
      </ReviewCard>

      {/* ── Sales Manager (shown for both finance=yes and finance=no paths) ── */}
      <ReviewCard
        title="Sales Manager"
        subtitle={
          agreementRequired
            ? "Captured in Step 5 alongside the agreement"
            : "Captured in Step 4 since finance is disabled"
        }
        icon={<ShieldCheck className="h-5 w-5" />}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <InfoRow
            label="Name"
            value={state.agreement?.salesManager?.name || "—"}
          />
          <InfoRow
            label="Email"
            value={state.agreement?.salesManager?.email || "—"}
          />
          <InfoRow
            label="Mobile"
            value={state.agreement?.salesManager?.mobile || "—"}
          />
          <InfoRow
            label="Age"
            value={(state.agreement?.salesManager as any)?.age || "—"}
          />
        </div>
      </ReviewCard>

      {/* ── Agreement sections (only when finance enabled) ── */}
      {agreementRequired && (
        <>
          <ReviewCard
            title="Agreement Summary"
            subtitle="Digio-managed agreement details collected in Step 5"
            icon={<FileText className="h-5 w-5" />}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <InfoRow
                label="Agreement Name"
                value={state.agreement?.agreementName}
              />
              <InfoRow
                label="Provider"
                value={state.agreement?.provider || "Digio"}
              />
              <InfoRow
                label="Agreement Status"
                value={
                  <StatusBadge status={state.agreement?.agreementStatus} />
                }
              />
              <InfoRow
                label="Completion Status"
                value={state.agreement?.completionStatus || "Pending"}
              />
              <InfoRow
                label="Date Of Signing"
                value={state.agreement?.dateOfSigning}
              />
              <InfoRow label="MoU Date" value={state.agreement?.mouDate} />
              
              <InfoRow
                label="Stamp Status"
                value={state.agreement?.stampStatus || "Pending"}
              />
              <InfoRow
                label="Request ID"
                value={state.agreement?.requestId || "Pending"}
              />
              <InfoRow
                label="Provider Document ID"
                value={state.agreement?.providerDocumentId || "Pending"}
              />
            </div>
          </ReviewCard>

          <ReviewCard
            title="Signer Details"
            subtitle="Participants involved in sequential signing"
            icon={<ShieldCheck className="h-5 w-5" />}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-[#E3E8EF] bg-[#FAFBFC] p-4">
                <h4 className="text-sm font-semibold text-[#173F63]">Dealer Signatory</h4>
                <div className="mt-3 space-y-2 text-sm text-slate-700">
                  <p>Name: {state.agreement?.dealerSignerName || "—"}</p>
                  <p>Designation: {state.agreement?.dealerSignerDesignation || "—"}</p>
                  <p>Email: {state.agreement?.dealerSignerEmail || "—"}</p>
                  <p>Phone: {state.agreement?.dealerSignerPhone || "—"}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-[#E3E8EF] bg-[#FAFBFC] p-4">
                <h4 className="text-sm font-semibold text-[#173F63]">iTarang Signatory 1</h4>
                <div className="mt-3 space-y-2 text-sm text-slate-700">
                  <p>Name: {state.agreement?.itarangSignatory1?.name || "—"}</p>
                  <p>Designation: {state.agreement?.itarangSignatory1?.designation || "—"}</p>
                  <p>Email: {state.agreement?.itarangSignatory1?.email || "—"}</p>
                  <p>Phone: {state.agreement?.itarangSignatory1?.mobile || "—"}</p>
                </div>
              </div>

              {state.agreement?.itarangSignatory2?.name?.trim() && (
                <div className="rounded-2xl border border-[#E3E8EF] bg-[#FAFBFC] p-4">
                  <h4 className="text-sm font-semibold text-[#173F63]">iTarang Signatory 2</h4>
                  <div className="mt-3 space-y-2 text-sm text-slate-700">
                    <p>Name: {state.agreement.itarangSignatory2.name}</p>
                    <p>Designation: {state.agreement.itarangSignatory2.designation || "—"}</p>
                    <p>Email: {state.agreement.itarangSignatory2.email || "—"}</p>
                    <p>Phone: {state.agreement.itarangSignatory2.mobile || "—"}</p>
                  </div>
                </div>
              )}
            </div>
          </ReviewCard>

          <ReviewCard
            title="Signing Order"
            subtitle="Fixed sequential order used for Digio workflow"
            icon={<CheckCircle2 className="h-5 w-5" />}
          >
            <div className="space-y-3">
              {signerFlow.map((item) => (
                <div
                  key={item.order}
                  className="flex items-center justify-between rounded-2xl border border-[#E3E8EF] bg-[#FAFBFC] px-4 py-3"
                >
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Step {item.order}
                    </p>
                    <p className="mt-1 text-sm font-medium text-slate-800">
                      {item.title}
                    </p>
                  </div>
                  <p className="text-sm text-slate-600">{item.name}</p>
                </div>
              ))}
            </div>
          </ReviewCard>

          <ReviewCard
            title="OEM Financing"
            subtitle="Shown only when OEM financing is enabled"
            icon={<Building2 className="h-5 w-5" />}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <InfoRow
                label="OEM Financing"
                value={state.agreement?.isOemFinancing ? "Yes" : "No"}
              />
              <InfoRow
                label="Vehicle Type"
                value={state.agreement?.vehicleType || "—"}
              />
              <InfoRow
                label="Manufacturer"
                value={state.agreement?.manufacturer || "—"}
              />
              <InfoRow label="Brand" value={state.agreement?.brand || "—"} />
              <InfoRow
                label="State Presence"
                value={state.agreement?.statePresence || "—"}
              />
            </div>
          </ReviewCard>
        </>
      )}

      {/* ── Confirmation Checkboxes ── */}
      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={state.reviewChecks.confirmInfo}
            onChange={(e) =>
              setField("reviewChecks", "confirmInfo", e.target.checked)
            }
            className="mt-1"
          />
          <span>I confirm all information submitted is correct</span>
        </label>
        {errors.confirmInfo && (
          <p className="text-sm text-red-600">{errors.confirmInfo}</p>
        )}

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={state.reviewChecks.confirmDocs}
            onChange={(e) =>
              setField("reviewChecks", "confirmDocs", e.target.checked)
            }
            className="mt-1"
          />
          <span>I confirm the uploaded documents are valid</span>
        </label>
        {errors.confirmDocs && (
          <p className="text-sm text-red-600">{errors.confirmDocs}</p>
        )}

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={state.reviewChecks.agreeTerms}
            onChange={(e) =>
              setField("reviewChecks", "agreeTerms", e.target.checked)
            }
            className="mt-1"
          />
          <span>I agree to iTarang onboarding and dealer terms</span>
        </label>
        {errors.agreeTerms && (
          <p className="text-sm text-red-600">{errors.agreeTerms}</p>
        )}

        {errors.agreementStatus && (
          <p className="text-sm text-red-600">{errors.agreementStatus}</p>
        )}
        {errors.documents && (
          <p className="text-sm text-red-600">{errors.documents}</p>
        )}
        {errors.ownerName && (
          <p className="text-sm text-red-600">{errors.ownerName}</p>
        )}
        {errors.ownerPhone && (
          <p className="text-sm text-red-600">{errors.ownerPhone}</p>
        )}
        {errors.ownerEmail && (
          <p className="text-sm text-red-600">{errors.ownerEmail}</p>
        )}
        {errors.api && (
          <p className="text-sm text-red-600">{errors.api}</p>
        )}

        {/* Render any other unexpected errors */}
        {Object.entries(errors)
          .filter(
            ([key]) =>
              ![
                "confirmInfo",
                "confirmDocs",
                "agreeTerms",
                "agreementStatus",
                "documents",
                "ownerName",
                "ownerPhone",
                "ownerEmail",
                "api",
              ].includes(key)
          )
          .map(([key, error]) => (
            <p key={key} className="text-sm text-red-600">
              {error}
            </p>
          ))}
      </div>

      {/* ── Navigation Buttons ── */}
      <div className="flex justify-between">
        <button
          type="button"
          onClick={prevStep}
          disabled={isSubmitting}
          className="rounded-2xl border border-[#E3E8EF] px-6 py-3 font-semibold text-slate-700 disabled:opacity-50"
        >
          ← Back
        </button>

        <button
          type="button"
          onClick={handleSubmitApplication}
          disabled={isSubmitting}
          className="rounded-2xl bg-[#1F5C8F] px-6 py-3 font-semibold text-white hover:bg-[#173F63] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSubmitting ? "Submitting..." : "Submit for Admin Review"}
        </button>
      </div>

      {/* Document preview modal — rendered last so it overlays everything */}
      <DocumentPreviewModal
        doc={previewDoc}
        onClose={() => setPreviewDoc(null)}
      />
    </div>
  );
}
