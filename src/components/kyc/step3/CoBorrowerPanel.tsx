"use client";

import Image from "next/image";
import { useState } from "react";

import AadhaarCard from "../cards/AadhaarCard";
import BankCard from "../cards/BankCard";
import CIBILCard from "../cards/CIBILCard";
import PANCard from "../cards/PANCard";
import RCCard from "../cards/RCCard";

// BRD §2.9.3 "Panel 3 — Co-Borrower KYC Review" — appended to the admin
// case-review screen whenever the lead has a coBorrowers row (admin triggered
// Need Co-Borrower KYC, and the dealer has submitted Step 3).
//
// Contents:
//   A. Read-only profile summary
//   B. 11-doc grid with review actions
//   C. Mini Aadhaar / PAN / Bank / CIBIL / RC verification cards, scoped to
//      the co-borrower via the cards' `applicant` prop.

export type CoBorrowerVerification = {
  id: string;
  type: string;
  applicant: string;
  status: string;
  matchScore: string | null;
  adminAction: string | null;
  adminActionNotes: string | null;
  apiResponse: Record<string, unknown> | null;
};

export type CoBorrowerDoc = {
  id: string;
  docType: string;
  fileUrl: string;
  status: string;
  ocrData: Record<string, unknown> | null;
  uploadedAt: string;
};

export type CoBorrowerData = {
  id: string;
  fullName: string;
  fatherOrHusbandName: string | null;
  dob: string | null;
  phone: string;
  permanentAddress: string | null;
  currentAddress: string | null;
  isCurrentSame: boolean | null;
  panNo: string | null;
  aadhaarNo: string | null;
  kycStatus: string;
  consentStatus: string;
  verificationSubmittedAt: string | null;
  documents: CoBorrowerDoc[];
  verificationCards: CoBorrowerVerification[];
  activeRequest: {
    id: string;
    attemptNumber: number;
    reason: string | null;
    status: string;
    createdAt: string;
  } | null;
};

interface Props {
  leadId: string;
  coBorrower: CoBorrowerData;
  onRefresh: () => void;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  aadhaar_front: "Aadhaar Front",
  aadhaar_back: "Aadhaar Back",
  pan_card: "PAN Card",
  passport_photo: "Passport Photo",
  address_proof: "Address Proof",
  rc_copy: "RC Copy",
  bank_statement: "Bank Statement",
  cheque_1: "Cheque 1",
  cheque_2: "Cheque 2",
  cheque_3: "Cheque 3",
  cheque_4: "Cheque 4",
};

function maskAadhaar(aadhaar: string | null): string {
  if (!aadhaar) return "—";
  const last4 = aadhaar.slice(-4);
  return `XXXX-XXXX-${last4}`;
}

export default function CoBorrowerPanel({
  leadId,
  coBorrower,
  onRefresh,
}: Props) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [reviewingDocId, setReviewingDocId] = useState("");
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [rejectionDrafts, setRejectionDrafts] = useState<
    Record<string, string>
  >({});
  const [error, setError] = useState("");

  const getVerification = (type: string) =>
    coBorrower.verificationCards.find((v) => v.type === type) || null;

  const reviewDoc = async (
    doc: CoBorrowerDoc,
    action: "approve" | "reject",
  ) => {
    const reason = rejectionDrafts[doc.id]?.trim() ?? "";
    if (action === "reject" && !reason) {
      setError("Rejection reason is required.");
      return;
    }
    setReviewingDocId(`${doc.id}:${action}`);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/kyc/${leadId}/coborrower-doc/${doc.id}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            note: noteDrafts[doc.id] ?? "",
            rejection_reason: action === "reject" ? reason : undefined,
          }),
        },
      );
      const data = await res.json();
      if (!data.success) {
        setError(data.error?.message ?? "Review failed");
        return;
      }
      onRefresh();
    } catch {
      setError("Network error");
    } finally {
      setReviewingDocId("");
    }
  };

  const profileFields: Array<[string, string]> = [
    ["Full Name", coBorrower.fullName || "—"],
    ["Father/Husband", coBorrower.fatherOrHusbandName || "—"],
    ["Phone", coBorrower.phone || "—"],
    ["DOB", coBorrower.dob || "—"],
    ["PAN", coBorrower.panNo || "—"],
    ["Aadhaar", maskAadhaar(coBorrower.aadhaarNo)],
    ["KYC Status", coBorrower.kycStatus],
    ["Consent", coBorrower.consentStatus],
  ];

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-purple-50 to-white flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Co-Borrower KYC (Step 3)
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            BRD §2.9.3 Panel 3
            {coBorrower.activeRequest
              ? ` · Attempt #${coBorrower.activeRequest.attemptNumber}`
              : ""}
          </p>
        </div>
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-purple-100 text-purple-700 capitalize">
          {coBorrower.kycStatus.replace(/_/g, " ")}
        </span>
      </div>

      {coBorrower.activeRequest?.reason && (
        <div className="px-5 py-3 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">
          <span className="font-semibold">Admin reason: </span>
          {coBorrower.activeRequest.reason}
        </div>
      )}

      {/* Profile */}
      <div className="px-5 py-4 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Profile
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          {profileFields.map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-gray-400">{label}</p>
              <p className="font-medium text-gray-800 break-words">{value}</p>
            </div>
          ))}
          {(coBorrower.permanentAddress || coBorrower.currentAddress) && (
            <div className="col-span-2 md:col-span-4">
              <p className="text-xs text-gray-400">Address</p>
              <p className="font-medium text-gray-800">
                {coBorrower.permanentAddress ||
                  coBorrower.currentAddress ||
                  "—"}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Documents */}
      {coBorrower.documents.length > 0 && (
        <div className="px-5 py-4 border-b border-gray-100">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Documents ({coBorrower.documents.length}/11)
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {coBorrower.documents.map((doc) => {
              const note = noteDrafts[doc.id] ?? "";
              const reason = rejectionDrafts[doc.id] ?? "";
              const isFinal = doc.status === "verified" || doc.status === "rejected";
              return (
                <div
                  key={doc.id}
                  className="border border-gray-200 rounded-lg overflow-hidden bg-white"
                >
                  <button
                    type="button"
                    onClick={() => setLightbox(doc.fileUrl)}
                    className="block w-full"
                  >
                    <div className="aspect-[4/3] bg-gray-100 relative">
                      {doc.fileUrl && !doc.fileUrl.match(/\.pdf(\?|$)/i) ? (
                        <Image
                          src={doc.fileUrl}
                          alt={doc.docType}
                          fill
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">
                          {doc.fileUrl ? "PDF" : "No file"}
                        </div>
                      )}
                    </div>
                  </button>
                  <div className="p-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-gray-800 truncate">
                        {DOC_TYPE_LABELS[doc.docType] || doc.docType}
                      </p>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          doc.status === "verified"
                            ? "bg-green-100 text-green-700"
                            : doc.status === "rejected"
                              ? "bg-red-100 text-red-700"
                              : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {doc.status}
                      </span>
                    </div>
                    {!isFinal && (
                      <>
                        <input
                          type="text"
                          value={note}
                          onChange={(e) =>
                            setNoteDrafts((p) => ({
                              ...p,
                              [doc.id]: e.target.value,
                            }))
                          }
                          placeholder="Admin note"
                          className="w-full text-[11px] border border-gray-200 rounded px-2 py-1"
                        />
                        <input
                          type="text"
                          value={reason}
                          onChange={(e) =>
                            setRejectionDrafts((p) => ({
                              ...p,
                              [doc.id]: e.target.value,
                            }))
                          }
                          placeholder="Reject reason"
                          className="w-full text-[11px] border border-gray-200 rounded px-2 py-1"
                        />
                        <div className="flex gap-1">
                          <button
                            onClick={() => reviewDoc(doc, "approve")}
                            disabled={reviewingDocId.startsWith(doc.id)}
                            className="flex-1 bg-green-600 hover:bg-green-700 text-white py-1 rounded text-[11px] font-medium disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => reviewDoc(doc, "reject")}
                            disabled={reviewingDocId.startsWith(doc.id)}
                            className="flex-1 bg-red-600 hover:bg-red-700 text-white py-1 rounded text-[11px] font-medium disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* API Verification Cards (mini) */}
      <div className="px-5 py-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Co-Borrower Verifications
        </p>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <AadhaarCard
            leadId={leadId}
            leadName={coBorrower.fullName}
            phone={coBorrower.phone}
            applicant="co_borrower"
            existingVerification={
              getVerification("aadhaar")
                ? {
                    id: getVerification("aadhaar")!.id,
                    status: getVerification("aadhaar")!.status,
                    adminAction: getVerification("aadhaar")!.adminAction,
                    adminActionNotes:
                      getVerification("aadhaar")!.adminActionNotes,
                  }
                : null
            }
            onActionComplete={onRefresh}
          />
          <PANCard
            leadId={leadId}
            leadName={coBorrower.fullName}
            panNumber={coBorrower.panNo || undefined}
            dob={coBorrower.dob || undefined}
            applicant="co_borrower"
            existingVerification={
              getVerification("pan")
                ? {
                    id: getVerification("pan")!.id,
                    status: getVerification("pan")!.status,
                    adminAction: getVerification("pan")!.adminAction,
                    adminActionNotes: getVerification("pan")!.adminActionNotes,
                    matchScore: getVerification("pan")!.matchScore,
                    apiResponse: getVerification("pan")!.apiResponse,
                  }
                : null
            }
            onActionComplete={onRefresh}
          />
          <BankCard
            leadId={leadId}
            leadName={coBorrower.fullName}
            applicant="co_borrower"
            existingVerification={
              getVerification("bank")
                ? {
                    id: getVerification("bank")!.id,
                    status: getVerification("bank")!.status,
                    adminAction: getVerification("bank")!.adminAction,
                    adminActionNotes: getVerification("bank")!.adminActionNotes,
                    matchScore: getVerification("bank")!.matchScore,
                    apiResponse: getVerification("bank")!.apiResponse,
                  }
                : null
            }
            onActionComplete={onRefresh}
          />
          <CIBILCard
            leadId={leadId}
            leadName={coBorrower.fullName}
            panNumber={coBorrower.panNo || undefined}
            dob={coBorrower.dob || undefined}
            phone={coBorrower.phone}
            address={
              coBorrower.permanentAddress || coBorrower.currentAddress || undefined
            }
            applicant="co_borrower"
            existingVerification={
              getVerification("cibil")
                ? {
                    id: getVerification("cibil")!.id,
                    status: getVerification("cibil")!.status,
                    matchScore: getVerification("cibil")!.matchScore,
                    adminAction: getVerification("cibil")!.adminAction,
                    adminActionNotes: getVerification("cibil")!.adminActionNotes,
                    apiResponse: getVerification("cibil")!.apiResponse,
                  }
                : null
            }
            onActionComplete={onRefresh}
          />
          <RCCard
            leadId={leadId}
            applicant="co_borrower"
            existingVerification={
              getVerification("rc")
                ? {
                    id: getVerification("rc")!.id,
                    status: getVerification("rc")!.status,
                    adminAction: getVerification("rc")!.adminAction,
                    adminActionNotes: getVerification("rc")!.adminActionNotes,
                    apiResponse: getVerification("rc")!.apiResponse,
                  }
                : null
            }
            onActionComplete={onRefresh}
          />
        </div>
      </div>

      {error && (
        <div className="px-5 py-3 bg-red-50 border-t border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative max-w-4xl max-h-full"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setLightbox(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center text-gray-600"
              aria-label="Close"
            >
              ×
            </button>
            {lightbox.match(/\.pdf(\?|$)/i) ? (
              <iframe
                src={lightbox}
                className="w-[80vw] h-[80vh] bg-white rounded-lg"
                title="Co-borrower document"
              />
            ) : (
              <Image
                src={lightbox}
                alt="Co-borrower document"
                width={800}
                height={600}
                className="max-h-[80vh] w-auto rounded-lg shadow-2xl"
                unoptimized
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
