"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import AadhaarCard from "./cards/AadhaarCard";
import PANCard from "./cards/PANCard";
import BankCard from "./cards/BankCard";
import CIBILCard from "./cards/CIBILCard";
import RCCard from "./cards/RCCard";

interface CrossMatchResult {
  overallPass: boolean;
  fields: Array<{
    field: string;
    leadValue: string | null;
    aadhaarValue: string | null;
    similarity: number;
    threshold: number;
    pass: boolean;
  }>;
  nameSimilarity?: number;
}

interface CaseReviewProps {
  leadId: string;
}

interface LeadInfo {
  id: string;
  name: string;
  phone: string;
  shopName: string;
  location: string;
  currentStatus: string;
}

interface PersonalDetails {
  aadhaarNo: string | null;
  panNo: string | null;
  dob: string | null;
  email: string | null;
  fatherHusbandName: string | null;
  localAddress: string | null;
  vehicleRc: string | null;
  financeType: string | null;
  financier: string | null;
  assetType: string | null;
}

interface Document {
  id: string;
  docType: string;
  fileUrl: string;
  fileName: string;
  verificationStatus: string;
  ocrData: Record<string, unknown> | null;
  uploadedAt: string;
}

interface VerificationCard {
  id: string;
  type: string;
  status: string;
  provider: string;
  matchScore: string | null;
  failedReason: string | null;
  retryCount: number;
  adminAction: string | null;
  adminActionNotes: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  apiResponse: Record<string, unknown> | null;
}

interface Consent {
  id: string;
  consentFor: string;
  consentType: string;
  consentStatus: string;
  signedAt: string | null;
  verifiedAt: string | null;
}

interface Metadata {
  caseType: string | null;
  couponCode: string | null;
  couponStatus: string | null;
  documentsCount: number | null;
  consentVerified: boolean | null;
  dealerEditsLocked: boolean | null;
  submissionTimestamp: string | null;
  verificationStartedAt: string | null;
  firstApiExecutionAt: string | null;
  firstApiType: string | null;
  finalDecision: string | null;
  finalDecisionAt: string | null;
}

interface QueueEntry {
  id: string;
  status: string;
  priority: string;
  assignedTo: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  slaAge: string | null;
}

interface DigilockerEntry {
  id: string;
  status: string;
  sessionId: string | null;
  linkSentAt: string | null;
  customerAuthorizedAt: string | null;
  aadhaarExtractedData: Record<string, string | null> | null;
  crossMatchResult: Record<string, unknown> | null;
  expiresAt: string | null;
}

interface CaseData {
  lead: LeadInfo;
  personalDetails: PersonalDetails | null;
  documents: Document[];
  verificationCards: VerificationCard[];
  consent: Consent[];
  metadata: Metadata | null;
  queueEntry: QueueEntry | null;
  reviews: unknown[];
  digilocker: DigilockerEntry[];
}

const DOC_TYPE_LABELS: Record<string, string> = {
  aadhaar_front: "Aadhaar Front",
  aadhaar_back: "Aadhaar Back",
  pan_card: "PAN Card",
  passport_photo: "Photo",
  address_proof: "Address Proof",
  rc_copy: "RC Copy",
  bank_statement: "Bank Statement",
  cheque_1: "Cheque 1",
  cheque_2: "Cheque 2",
  cheque_3: "Cheque 3",
  cheque_4: "Cheque 4",
};

export default function CaseReview({ leadId }: CaseReviewProps) {
  const [data, setData] = useState<CaseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"verifications" | "documents">("verifications");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected" | "">("");
  const [decisionNotes, setDecisionNotes] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionResult, setDecisionResult] = useState<{ success: boolean; message: string } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/kyc/${leadId}/case-review`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        setError(`API returned ${res.status} — try restarting the dev server (delete .next and run npm run dev)`);
        return;
      }
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      } else {
        setError(json.error?.message || "Failed to load case");
      }
    } catch {
      setError("Network error loading case data");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const getVerification = (type: string) =>
    data?.verificationCards.find((v) => v.type === type) || null;

  const latestDigilocker = data?.digilocker?.[0] || null;

  // Extract OCR data from uploaded documents to auto-fill card inputs
  // Handles both flat and nested Decentro OCR response formats (e.g. data.kycResult.*)
  const getOcrField = (docType: string, ...fields: string[]): string | undefined => {
    const doc = data?.documents.find((d) => d.docType === docType);
    if (!doc?.ocrData) return undefined;
    const ocr = doc.ocrData as Record<string, unknown>;
    // Search in top-level, then nested kycResult/extractedData/result
    const searchTargets: Record<string, unknown>[] = [ocr];
    for (const nested of ["kycResult", "extractedData", "result", "ocrResult"]) {
      if (ocr[nested] && typeof ocr[nested] === "object") {
        searchTargets.push(ocr[nested] as Record<string, unknown>);
      }
    }
    for (const target of searchTargets) {
      for (const f of fields) {
        const val = target[f];
        if (typeof val === "string" && val.trim()) return val.trim();
      }
    }
    return undefined;
  };

  const ocrPan = getOcrField("pan_card", "pan_number", "panNumber", "id_number", "idNumber", "pan", "panNo");
  const ocrDob = getOcrField("pan_card", "dob", "dateOfBirth", "date_of_birth")
    || getOcrField("aadhaar_front", "dob", "dateOfBirth", "date_of_birth");
  // Bank OCR - Decentro doesn't support bank statement/cheque OCR natively,
  // so these will mostly come from manual entry or personalDetails
  const ocrAccountNumber = getOcrField("bank_statement", "account_number", "accountNumber")
    || getOcrField("cheque_1", "account_number", "accountNumber")
    || getOcrField("cheque_2", "account_number", "accountNumber")
    || getOcrField("cheque_3", "account_number", "accountNumber")
    || getOcrField("cheque_4", "account_number", "accountNumber");
  const ocrIfsc = getOcrField("bank_statement", "ifsc", "ifsc_code", "ifscCode")
    || getOcrField("cheque_1", "ifsc", "ifsc_code", "ifscCode")
    || getOcrField("cheque_2", "ifsc", "ifsc_code", "ifscCode")
    || getOcrField("cheque_3", "ifsc", "ifsc_code", "ifscCode")
    || getOcrField("cheque_4", "ifsc", "ifsc_code", "ifscCode");
  const ocrBankName = getOcrField("bank_statement", "bank_name", "bankName")
    || getOcrField("cheque_1", "bank_name", "bankName")
    || getOcrField("cheque_2", "bank_name", "bankName");
  const ocrBranch = getOcrField("bank_statement", "branch", "branchName")
    || getOcrField("cheque_1", "branch", "branchName")
    || getOcrField("cheque_2", "branch", "branchName");
  const ocrRcNumber = getOcrField("rc_copy", "rc_number", "rcNumber", "registration_number", "registrationNumber");

  const handleFinalDecision = async () => {
    if (!decision) return;
    if (decision === "rejected" && !rejectionReason.trim()) {
      setDecisionResult({ success: false, message: "Rejection reason is required" });
      return;
    }
    setDecisionLoading(true);
    setDecisionResult(null);
    try {
      const res = await fetch(`/api/admin/kyc/${leadId}/final-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          notes: decisionNotes,
          rejection_reason: decision === "rejected" ? rejectionReason : undefined,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setDecisionResult({ success: true, message: json.data.message });
        fetchData();
      } else {
        setDecisionResult({ success: false, message: json.error?.message || "Failed" });
      }
    } catch {
      setDecisionResult({ success: false, message: "Network error" });
    } finally {
      setDecisionLoading(false);
    }
  };

  const priorityColor = (p: string) => {
    if (p === "high") return "bg-red-100 text-red-700";
    if (p === "medium") return "bg-yellow-100 text-yellow-700";
    return "bg-green-100 text-green-700";
  };

  const docStatusColor = (s: string) => {
    if (s === "success") return "bg-green-100 text-green-700";
    if (s === "failed") return "bg-red-100 text-red-700";
    if (s === "in_progress" || s === "awaiting_action") return "bg-yellow-100 text-yellow-700";
    return "bg-gray-100 text-gray-600";
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-teal-600" />
        <span className="ml-4 text-gray-600">Loading case review...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-2xl mx-auto py-20 text-center">
        <div className="bg-red-50 border border-red-200 rounded-xl p-6">
          <p className="text-red-700 font-medium">{error || "Case not found"}</p>
          <button onClick={() => { setError(""); setLoading(true); fetchData(); }}
            className="mt-3 text-sm text-red-600 underline">Retry</button>
        </div>
      </div>
    );
  }

  const { lead, personalDetails: pd, documents, metadata, queueEntry, consent } = data;
  const isFinalDecided = metadata?.finalDecision === "approved" || metadata?.finalDecision === "rejected";

  return (
    <div className="space-y-6">
      {/* Top Bar */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">KYC Case Review</h1>
          <p className="text-sm text-gray-500 mt-0.5">Lead #{lead.id} &middot; {lead.name}</p>
        </div>
        <div className="flex items-center gap-3">
          {queueEntry && (
            <>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${priorityColor(queueEntry.priority)}`}>
                {queueEntry.priority.charAt(0).toUpperCase() + queueEntry.priority.slice(1)} Priority
              </span>
              {queueEntry.slaAge && (
                <span className="text-xs text-gray-500">SLA: {queueEntry.slaAge}</span>
              )}
            </>
          )}
          {metadata?.finalDecision && (
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
              metadata.finalDecision === "approved" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
            }`}>
              {metadata.finalDecision.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      {/* Lead Info + Metadata Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Lead Info */}
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-4">Lead Information</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-400">Full Name</p>
              <p className="font-medium text-gray-800">{lead.name || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Phone</p>
              <p className="font-medium text-gray-800">{lead.phone || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Shop</p>
              <p className="font-medium text-gray-800">{lead.shopName || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Location</p>
              <p className="font-medium text-gray-800">{lead.location || "—"}</p>
            </div>
            {pd?.dob && (
              <div>
                <p className="text-xs text-gray-400">DOB</p>
                <p className="font-medium text-gray-800">{pd.dob}</p>
              </div>
            )}
            {pd?.fatherHusbandName && (
              <div>
                <p className="text-xs text-gray-400">Father/Husband</p>
                <p className="font-medium text-gray-800">{pd.fatherHusbandName}</p>
              </div>
            )}
            {pd?.aadhaarNo && (
              <div>
                <p className="text-xs text-gray-400">Aadhaar</p>
                <p className="font-medium text-gray-800">XXXX-XXXX-{pd.aadhaarNo.slice(-4)}</p>
              </div>
            )}
            {pd?.panNo && (
              <div>
                <p className="text-xs text-gray-400">PAN</p>
                <p className="font-medium text-gray-800">{pd.panNo}</p>
              </div>
            )}
            {pd?.vehicleRc && (
              <div>
                <p className="text-xs text-gray-400">Vehicle RC</p>
                <p className="font-medium text-gray-800">{pd.vehicleRc}</p>
              </div>
            )}
            {pd?.localAddress && (
              <div className="col-span-2 md:col-span-3">
                <p className="text-xs text-gray-400">Address</p>
                <p className="font-medium text-gray-800">{pd.localAddress}</p>
              </div>
            )}
            {pd?.financeType && (
              <div>
                <p className="text-xs text-gray-400">Finance Type</p>
                <p className="font-medium text-gray-800">{pd.financeType}</p>
              </div>
            )}
            {pd?.assetType && (
              <div>
                <p className="text-xs text-gray-400">Asset Type</p>
                <p className="font-medium text-gray-800">{pd.assetType}</p>
              </div>
            )}
          </div>
        </div>

        {/* Side Panel: Coupon + Consent + Queue */}
        <div className="space-y-4">
          {/* Coupon */}
          {metadata && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Coupon & Case</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Coupon</span>
                  <span className="font-mono font-medium text-gray-800">{metadata.couponCode || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Coupon Status</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    metadata.couponStatus === "used" ? "bg-green-100 text-green-700" :
                    metadata.couponStatus === "reserved" ? "bg-yellow-100 text-yellow-700" :
                    "bg-gray-100 text-gray-600"
                  }`}>
                    {metadata.couponStatus || "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Case Type</span>
                  <span className="font-medium text-gray-800 capitalize">{metadata.caseType || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Documents</span>
                  <span className="font-medium text-gray-800">{metadata.documentsCount || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Dealer Edits</span>
                  <span className={`text-xs font-medium ${metadata.dealerEditsLocked ? "text-red-600" : "text-green-600"}`}>
                    {metadata.dealerEditsLocked ? "Locked" : "Unlocked"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Consent */}
          {consent.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Consent</p>
              {consent.map((c) => (
                <div key={c.id} className="flex justify-between text-sm mb-1.5">
                  <span className="text-gray-500 capitalize">{c.consentFor}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    c.consentStatus === "verified" || c.consentStatus === "digitally_signed"
                      ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                  }`}>
                    {c.consentStatus.replace(/_/g, " ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        <button onClick={() => setActiveTab("verifications")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeTab === "verifications" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
          }`}>
          Verification Cards
        </button>
        <button onClick={() => setActiveTab("documents")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeTab === "documents" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
          }`}>
          Documents ({documents.length})
        </button>
      </div>

      {/* Verification Cards */}
      {activeTab === "verifications" && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* Aadhaar */}
          <AadhaarCard
            leadId={leadId}
            leadName={lead.name}
            phone={lead.phone}
            email={pd?.email || undefined}
            existingTransaction={latestDigilocker ? {
              id: latestDigilocker.id,
              status: latestDigilocker.status,
              aadhaarExtractedData: latestDigilocker.aadhaarExtractedData,
              crossMatchResult: latestDigilocker.crossMatchResult as CrossMatchResult | null,
              expiresAt: latestDigilocker.expiresAt || undefined,
            } : null}
            existingVerification={getVerification("aadhaar") ? {
              id: getVerification("aadhaar")!.id,
              status: getVerification("aadhaar")!.status,
              adminAction: getVerification("aadhaar")!.adminAction,
              adminActionNotes: getVerification("aadhaar")!.adminActionNotes,
            } : null}
            onActionComplete={fetchData}
          />

          {/* PAN */}
          <PANCard
            leadId={leadId}
            leadName={lead.name}
            panNumber={pd?.panNo || ocrPan || undefined}
            dob={pd?.dob || ocrDob || undefined}
            existingVerification={getVerification("pan") ? {
              id: getVerification("pan")!.id,
              status: getVerification("pan")!.status,
              adminAction: getVerification("pan")!.adminAction,
              adminActionNotes: getVerification("pan")!.adminActionNotes,
              matchScore: getVerification("pan")!.matchScore,
              apiResponse: getVerification("pan")!.apiResponse,
            } : null}
            onActionComplete={fetchData}
          />

          {/* Bank */}
          <BankCard
            leadId={leadId}
            leadName={lead.name}
            accountNumber={ocrAccountNumber}
            ifsc={ocrIfsc}
            bankName={ocrBankName}
            branch={ocrBranch}
            existingVerification={getVerification("bank") ? {
              id: getVerification("bank")!.id,
              status: getVerification("bank")!.status,
              adminAction: getVerification("bank")!.adminAction,
              adminActionNotes: getVerification("bank")!.adminActionNotes,
              matchScore: getVerification("bank")!.matchScore,
              apiResponse: getVerification("bank")!.apiResponse,
            } : null}
            onActionComplete={fetchData}
          />

          {/* CIBIL */}
          <CIBILCard
            leadId={leadId}
            leadName={lead.name}
            panNumber={pd?.panNo || ocrPan || undefined}
            dob={pd?.dob || ocrDob || undefined}
            phone={lead.phone}
            address={pd?.localAddress || undefined}
            existingVerification={getVerification("cibil") ? {
              id: getVerification("cibil")!.id,
              status: getVerification("cibil")!.status,
              matchScore: getVerification("cibil")!.matchScore,
              adminAction: getVerification("cibil")!.adminAction,
              adminActionNotes: getVerification("cibil")!.adminActionNotes,
              apiResponse: getVerification("cibil")!.apiResponse,
            } : null}
            onActionComplete={fetchData}
          />

          {/* RC */}
          <RCCard
            leadId={leadId}
            rcNumber={pd?.vehicleRc || ocrRcNumber || undefined}
            existingVerification={getVerification("rc") ? {
              id: getVerification("rc")!.id,
              status: getVerification("rc")!.status,
              adminAction: getVerification("rc")!.adminAction,
              adminActionNotes: getVerification("rc")!.adminActionNotes,
              apiResponse: getVerification("rc")!.apiResponse,
            } : null}
            onActionComplete={fetchData}
          />
        </div>
      )}

      {/* Documents Tab */}
      {activeTab === "documents" && (
        <div>
          {documents.length === 0 ? (
            <div className="bg-gray-50 rounded-xl p-8 text-center text-gray-500">No documents uploaded yet.</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {documents.map((doc) => (
                <button key={doc.id} onClick={() => setLightboxUrl(doc.fileUrl)}
                  className="group bg-white border border-gray-200 rounded-xl p-3 hover:border-teal-400 hover:shadow-md transition-all text-left">
                  <div className="aspect-[4/3] bg-gray-100 rounded-lg mb-2 overflow-hidden flex items-center justify-center relative">
                    {doc.fileUrl ? (
                      <Image src={doc.fileUrl} alt={doc.docType} fill
                        className="object-cover group-hover:scale-105 transition-transform" />
                    ) : (
                      <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    )}
                  </div>
                  <p className="text-xs font-medium text-gray-700 truncate">
                    {DOC_TYPE_LABELS[doc.docType] || doc.docType}
                  </p>
                  <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${docStatusColor(doc.verificationStatus)}`}>
                    {doc.verificationStatus}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Document Lightbox */}
      {lightboxUrl && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
          onClick={() => setLightboxUrl(null)}>
          <div className="relative max-w-4xl max-h-full" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setLightboxUrl(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center text-gray-600 hover:text-gray-900">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <Image src={lightboxUrl} alt="Document" width={800} height={600}
              className="max-h-[80vh] w-auto rounded-lg shadow-2xl" />
          </div>
        </div>
      )}

      {/* Final Decision Panel */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-6 sticky bottom-4 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Final Decision</h2>
          {isFinalDecided && metadata?.finalDecision && (
            <span className={`px-4 py-1.5 rounded-full text-sm font-semibold ${
              metadata.finalDecision === "approved" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
            }`}>
              Already {metadata.finalDecision.toUpperCase()}
            </span>
          )}
        </div>

        {!isFinalDecided ? (
          <div className="space-y-4">
            <div className="flex gap-4">
              <label className={`flex-1 flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                decision === "approved" ? "border-green-500 bg-green-50" : "border-gray-200 hover:border-gray-300"
              }`}>
                <input type="radio" name="decision" value="approved"
                  checked={decision === "approved"}
                  onChange={() => setDecision("approved")}
                  className="w-4 h-4 text-green-600" />
                <div>
                  <p className="font-semibold text-gray-800">Approve</p>
                  <p className="text-xs text-gray-500">KYC verified, coupon consumed</p>
                </div>
              </label>
              <label className={`flex-1 flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                decision === "rejected" ? "border-red-500 bg-red-50" : "border-gray-200 hover:border-gray-300"
              }`}>
                <input type="radio" name="decision" value="rejected"
                  checked={decision === "rejected"}
                  onChange={() => setDecision("rejected")}
                  className="w-4 h-4 text-red-600" />
                <div>
                  <p className="font-semibold text-gray-800">Reject</p>
                  <p className="text-xs text-gray-500">Dealer edits unlocked</p>
                </div>
              </label>
            </div>

            {decision === "rejected" && (
              <div>
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Rejection Reason *</label>
                <textarea value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} rows={2}
                  placeholder="Why is this being rejected?"
                  className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-red-500 focus:border-red-500" />
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Notes (optional)</label>
              <textarea value={decisionNotes} onChange={(e) => setDecisionNotes(e.target.value)} rows={2}
                placeholder="Additional notes..."
                className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-teal-500 focus:border-teal-500" />
            </div>

            <div className="flex gap-3">
              <button onClick={handleFinalDecision} disabled={!decision || decisionLoading}
                className={`px-8 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors ${
                  decision === "approved"
                    ? "bg-green-600 hover:bg-green-700 text-white"
                    : decision === "rejected"
                      ? "bg-red-600 hover:bg-red-700 text-white"
                      : "bg-gray-300 text-gray-500 cursor-not-allowed"
                }`}>
                {decisionLoading ? "Submitting..." : "Submit Decision"}
              </button>
              <Link href="/admin/kyc-review"
                className="px-6 py-2.5 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors inline-flex items-center">
                Back to Queue
              </Link>
            </div>

            {decisionResult && (
              <div className={`rounded-lg p-3 text-sm ${
                decisionResult.success ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
              }`}>
                {decisionResult.message}
              </div>
            )}
          </div>
        ) : (
          <div className="flex gap-3">
            <Link href="/admin/kyc-review"
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-700 text-white transition-colors">
              Back to Queue
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
