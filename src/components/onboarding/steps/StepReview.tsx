"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useOnboardingStore } from "@/store/onboardingStore";

function ReviewCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-white">
      <div className="px-5 py-4 border-b border-[#E3E8EF]">
        <h3 className="text-lg font-semibold text-[#173F63]">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
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

function getPrimaryContact(state: ReturnType<typeof useOnboardingStore.getState>) {
  const companyType = state.company?.companyType;

  if (companyType === "sole_proprietorship") {
    return {
      ownerName: state.ownership?.ownerName || "",
      ownerPhone: state.ownership?.ownerPhone || "",
      ownerEmail: state.ownership?.ownerEmail || "",
    };
  }

  if (companyType === "partnership_firm") {
    const firstPartner = state.ownership?.partners?.[0];
    return {
      ownerName: firstPartner?.name || "",
      ownerPhone: firstPartner?.phone || "",
      ownerEmail: firstPartner?.email || "",
    };
  }

  if (companyType === "private_limited_firm") {
    const firstDirector = state.ownership?.directors?.[0];
    return {
      ownerName: firstDirector?.name || "",
      ownerPhone: firstDirector?.phone || "",
      ownerEmail: firstDirector?.email || "",
    };
  }

  return {
    ownerName: state.ownership?.ownerName || "",
    ownerPhone: state.ownership?.ownerPhone || "",
    ownerEmail: state.ownership?.ownerEmail || "",
  };
}

export default function StepReview() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const state = useOnboardingStore();
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const setField = useOnboardingStore((s) => s.setField);
  const errors = useOnboardingStore((s) => s.errors);
  const setErrors = useOnboardingStore((s) => s.setErrors);
  const completeOnboarding = useOnboardingStore((s) => s.completeOnboarding);

  const primaryContact = getPrimaryContact(state);

  const handleSubmitApplication = async () => {
    const submitErrors: Record<string, string> = {};

    if (!state.reviewChecks.confirmInfo) {
      submitErrors.confirmInfo = "Please confirm all information is correct";
    }

    if (!state.reviewChecks.confirmDocs) {
      submitErrors.confirmDocs = "Please confirm uploaded documents are valid";
    }

    if (!state.reviewChecks.agreeTerms) {
      submitErrors.agreeTerms = "Please agree to iTarang onboarding and dealer terms";
    }

    const documents = [
      buildDocument("itr_3_years", state.compliance?.itr3Years),
      buildDocument("bank_statement_3_months", state.compliance?.bankStatement3Months),
      buildDocument("undated_cheques", state.compliance?.undatedCheques),
      buildDocument("passport_photo", state.compliance?.passportPhoto),
      buildDocument("udyam_certificate", state.compliance?.udyamCertificate),
      buildDocument("gst_certificate", state.company?.gstCertificate),
      buildDocument("pan_card", state.company?.companyPanFile),
    ].filter((doc): doc is DealerDocumentPayload => doc !== null);

    if (documents.length === 0) {
      submitErrors.documents = "Please upload at least one valid document before submitting";
    }

    if (!primaryContact.ownerName) {
      submitErrors.ownerName = "Primary contact name is required before submission";
    }

    if (!primaryContact.ownerPhone) {
      submitErrors.ownerPhone = "Primary contact phone is required before submission";
    }

    if (!primaryContact.ownerEmail) {
      submitErrors.ownerEmail = "Primary contact email is required before submission";
    }

    if (Object.keys(submitErrors).length > 0) {
      setErrors(submitErrors);
      return;
    }

    try {
      setIsSubmitting(true);

      const payload = {
        dealerUserId: state.dealerId || null,
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

        ownerName: primaryContact.ownerName,
        ownerPhone: primaryContact.ownerPhone,
        ownerEmail: primaryContact.ownerEmail,

        bankName: state.ownership?.bankName || "",
        accountNumber: state.ownership?.accountNumber || "",
        beneficiaryName: state.ownership?.beneficiaryName || "",
        ifscCode: state.ownership?.ifsc || "",
        documents,
      };

      console.log("FINAL SUBMIT PAYLOAD", payload);

      const response = await fetch("/api/dealer-onboarding/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        setErrors({
          api: result.message || "Failed to submit dealer onboarding application",
        });
        return;
      }

      const generatedDealerId = completeOnboarding();

      console.log("Dealer onboarding saved in DB:", result.application);
      console.log("Dealer onboarding completed with ID:", generatedDealerId);

      router.push("/dealer-portal");
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
      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 md:p-8 shadow-sm">
        <h2 className="text-2xl font-bold text-[#173F63]">Review Application</h2>
        <p className="text-slate-500 mt-1">
          Review your details before final submission.
        </p>
      </div>

      <ReviewCard title="Company Details">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-slate-700">
          <p>Company Name: {state.company?.companyName || "—"}</p>
          <p>Company Type: {state.company?.companyType || "—"}</p>
          <p>GST: {state.company?.gstNumber || "—"}</p>
          <p>PAN: {state.company?.companyPanNumber || "—"}</p>
          <p className="md:col-span-2">Address: {state.company?.companyAddress || "—"}</p>
        </div>
      </ReviewCard>

      <ReviewCard title="Primary Contact Details">
        <div className="space-y-2 text-sm text-slate-700">
          <p>Name: {primaryContact.ownerName || "—"}</p>
          <p>Phone: {primaryContact.ownerPhone || "—"}</p>
          <p>Email: {primaryContact.ownerEmail || "—"}</p>
        </div>
      </ReviewCard>

      <ReviewCard title="Compliance Documents">
        <div className="space-y-2 text-sm text-slate-700">
          <p>ITR: {state.compliance?.itr3Years?.file?.name || "Not uploaded"}</p>
          <p>
            Bank Statement:{" "}
            {state.compliance?.bankStatement3Months?.file?.name || "Not uploaded"}
          </p>
          <p>
            Undated Cheques:{" "}
            {state.compliance?.undatedCheques?.file?.name || "Not uploaded"}
          </p>
          <p>
            Passport Photo:{" "}
            {state.compliance?.passportPhoto?.file?.name || "Not uploaded"}
          </p>
          <p>
            Udyam Certificate:{" "}
            {state.compliance?.udyamCertificate?.file?.name || "Not uploaded"}
          </p>
          <p>
            GST Certificate: {state.company?.gstCertificate?.file?.name || "Not uploaded"}
          </p>
          <p>
            Company PAN File: {state.company?.companyPanFile?.file?.name || "Not uploaded"}
          </p>
        </div>
      </ReviewCard>

      <ReviewCard title="Ownership Details">
        <div className="space-y-2 text-sm text-slate-700">
          <p>Bank Name: {state.ownership?.bankName || "—"}</p>
          <p>Account Number: {state.ownership?.accountNumber || "—"}</p>
          <p>IFSC: {state.ownership?.ifsc || "—"}</p>
          <p>Beneficiary Name: {state.ownership?.beneficiaryName || "—"}</p>
        </div>
      </ReviewCard>

      <ReviewCard title="Finance Enablement Selection">
        <p className="text-sm text-slate-700">
          Finance Enabled: {state.finance?.enableFinance === "yes" ? "Yes" : "No"}
        </p>
      </ReviewCard>

      <ReviewCard title="Dealer Agreement Status">
        <div className="space-y-2 text-sm text-slate-700">
          <p>Agreement required: {state.finance?.enableFinance === "yes" ? "Yes" : "No"}</p>
          <p>Agreement status: {state.agreement?.agreementStatus || "Pending"}</p>
          <p>Signer details: {state.agreement?.dealerSignerName || "Pending"}</p>
        </div>
      </ReviewCard>

      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm space-y-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={state.reviewChecks.confirmInfo}
            onChange={(e) => setField("reviewChecks", "confirmInfo", e.target.checked)}
            className="mt-1"
          />
          <span>I confirm all information submitted is correct</span>
        </label>
        {errors.confirmInfo && (
          <p className="text-sm text-red-600">{errors.confirmInfo}</p>
        )}

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={state.reviewChecks.confirmDocs}
            onChange={(e) => setField("reviewChecks", "confirmDocs", e.target.checked)}
            className="mt-1"
          />
          <span>I confirm the uploaded documents are valid</span>
        </label>
        {errors.confirmDocs && (
          <p className="text-sm text-red-600">{errors.confirmDocs}</p>
        )}

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={state.reviewChecks.agreeTerms}
            onChange={(e) => setField("reviewChecks", "agreeTerms", e.target.checked)}
            className="mt-1"
          />
          <span>I agree to iTarang onboarding and dealer terms</span>
        </label>
        {errors.agreeTerms && (
          <p className="text-sm text-red-600">{errors.agreeTerms}</p>
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

        {errors.api && <p className="text-sm text-red-600">{errors.api}</p>}

        {Object.entries(errors)
          .filter(
            ([key]) =>
              ![
                "confirmInfo",
                "confirmDocs",
                "agreeTerms",
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

      <div className="flex justify-between">
        <button
          type="button"
          onClick={prevStep}
          disabled={isSubmitting}
          className="px-6 py-3 rounded-2xl border border-[#E3E8EF] text-slate-700 font-semibold disabled:opacity-50"
        >
          ← Back
        </button>

        <button
          type="button"
          onClick={handleSubmitApplication}
          disabled={isSubmitting}
          className="px-6 py-3 rounded-2xl bg-[#1F5C8F] text-white font-semibold hover:bg-[#173F63] disabled:opacity-50"
        >
          {isSubmitting ? "Submitting..." : "Submit Dealer Application"}
        </button>
      </div>
    </div>
  );
}