"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import AadhaarCard from "./cards/AadhaarCard";
import PANCard from "./cards/PANCard";
import BankCard from "./cards/BankCard";
import CIBILCard from "./cards/CIBILCard";
import RCCard from "./cards/RCCard";
import ConsentPdfViewerModal from "./ConsentPdfViewerModal";
import SupportingDocsPanel, {
  type SupportingDoc,
} from "./step3/SupportingDocsPanel";
import CoBorrowerPanel, {
  type CoBorrowerData,
} from "./step3/CoBorrowerPanel";

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
  generatedPdfUrl: string | null;
  signedConsentUrl: string | null;
  signedAt: string | null;
  verifiedAt: string | null;
  adminViewedBy: string | null;
  adminViewedAt: string | null;
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
  supportingDocs: SupportingDoc[];
  coBorrower: CoBorrowerData | null;
}

function formatRelativeTime(isoString: string | null): string | null {
  if (!isoString) return null;
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(isoString).toLocaleDateString();
}

function prettyConsentType(type: string | null): string {
  if (!type) return "";
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");
}

function prettyConsentFor(value: string): string {
  if (value === "primary") return "Primary Borrower";
  if (value === "co_borrower") return "Co-borrower";
  return value.replace(/_/g, " ");
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
  const [decision, setDecision] = useState<
    "approved" | "rejected" | "dealer_action_required" | ""
  >("");
  const [decisionNotes, setDecisionNotes] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionResult, setDecisionResult] = useState<{ success: boolean; message: string } | null>(null);
  const [viewingConsent, setViewingConsent] = useState<Consent | null>(null);
  const [consentActionLoading, setConsentActionLoading] = useState<string | null>(null);
  const [consentActionError, setConsentActionError] = useState<string | null>(null);
  const [pendingRejectId, setPendingRejectId] = useState<string | null>(null);

  const handleConsentVerify = useCallback(
    async (c: Consent, action: "approve" | "reject") => {
      setConsentActionError(null);
      setConsentActionLoading(`${c.id}:${action}`);
      try {
        const res = await fetch(
          `/api/admin/kyc/${leadId}/consent/${c.id}/verify`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        const json = await res.json();
        if (!json.success) {
          setConsentActionError(json.error?.message || "Action failed");
          return;
        }
        setPendingRejectId(null);
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            consent: prev.consent.map((item) =>
              item.id === c.id
                ? {
                    ...item,
                    consentStatus: json.consent.consentStatus,
                    verifiedAt: json.consent.verifiedAt,
                  }
                : item,
            ),
          };
        });
      } catch {
        setConsentActionError("Network error");
      } finally {
        setConsentActionLoading(null);
      }
    },
    [leadId],
  );

  const handleConsentClick = useCallback(async (c: Consent) => {
    if (c.consentFor !== "primary") return;
    const pdfUrl = c.signedConsentUrl ?? c.generatedPdfUrl;
    if (!pdfUrl) return;
    setViewingConsent(c);
    if (c.adminViewedAt) return;
    try {
      const res = await fetch(`/api/admin/kyc/${leadId}/consent/${c.id}/view`, {
        method: "POST",
      });
      const json = await res.json();
      if (json.success) {
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            consent: prev.consent.map((item) =>
              item.id === c.id
                ? {
                    ...item,
                    adminViewedBy: json.consent.adminViewedBy,
                    adminViewedAt: json.consent.adminViewedAt,
                  }
                : item,
            ),
          };
        });
      }
    } catch (err) {
      console.error("[Consent View] Failed to mark viewed:", err);
    }
  }, [leadId]);

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
        setDecisionResult({
          success: true,
          message: json.data?.message ?? "Saved.",
        });
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

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full border-4 border-teal-100" />
          <div className="absolute inset-0 rounded-full border-4 border-teal-600 border-t-transparent animate-spin" />
        </div>
        <span className="text-sm font-medium text-gray-600">Loading case review…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-2xl mx-auto py-20 text-center">
        <div className="bg-gradient-to-br from-red-50 to-rose-50 border border-red-200 rounded-2xl p-8 shadow-sm">
          <div className="w-12 h-12 rounded-full bg-red-100 mx-auto mb-3 flex items-center justify-center">
            <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          </div>
          <p className="text-red-700 font-semibold">{error || "Case not found"}</p>
          <button onClick={() => { setError(""); setLoading(true); fetchData(); }}
            className="mt-4 px-4 py-2 text-sm font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors">Retry</button>
        </div>
      </div>
    );
  }

  const { lead, personalDetails: pd, documents, metadata, queueEntry, consent } = data;
  const isFinalDecided = metadata?.finalDecision === "approved" || metadata?.finalDecision === "rejected";
  const initials = (lead.name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || "")
    .join("") || "?";

  // Verification completion snapshot
  const verifTypes = ["aadhaar", "pan", "bank", "cibil", "rc"] as const;
  const verifStats = verifTypes.map((t) => {
    const v = data.verificationCards.find((c) => c.type === t);
    return { type: t, status: v?.status || "pending" };
  });
  const verifCompleted = verifStats.filter((v) => v.status === "success" || v.status === "completed").length;
  const verifProgress = Math.round((verifCompleted / verifTypes.length) * 100);

  return (
    <div className="space-y-6 pb-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {/* Left accent bar */}
        <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-teal-500 to-emerald-500" />

        <div className="relative p-5 md:p-6">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-teal-50 ring-1 ring-teal-100 flex items-center justify-center text-teal-700 font-bold text-base">
                {initials}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-teal-50 text-[10px] font-semibold text-teal-700 ring-1 ring-teal-100 uppercase tracking-wide">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" /></svg>
                    KYC Case Review
                  </span>
                  <span className="text-[11px] text-gray-400 font-mono">#{lead.id.slice(0, 8)}</span>
                </div>
                <h1 className="text-xl md:text-2xl font-bold text-gray-900 truncate">{lead.name || "Unnamed Lead"}</h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-gray-500">
                  {lead.phone && (
                    <span className="inline-flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                      {lead.phone}
                    </span>
                  )}
                  {lead.location && (
                    <span className="inline-flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                      {lead.location}
                    </span>
                  )}
                  {lead.shopName && (
                    <span className="inline-flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                      {lead.shopName}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 lg:flex-shrink-0">
              {queueEntry && (
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ring-1 ring-inset ${
                  queueEntry.priority === "high" ? "bg-red-50 text-red-700 ring-red-600/20" :
                  queueEntry.priority === "medium" ? "bg-amber-50 text-amber-700 ring-amber-600/20" :
                  "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    queueEntry.priority === "high" ? "bg-red-500" :
                    queueEntry.priority === "medium" ? "bg-amber-500" :
                    "bg-emerald-500"
                  }`} />
                  {queueEntry.priority.charAt(0).toUpperCase() + queueEntry.priority.slice(1)} Priority
                </span>
              )}
              {queueEntry?.slaAge && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600 ring-1 ring-inset ring-gray-200">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  SLA {queueEntry.slaAge}
                </span>
              )}
              {metadata?.finalDecision && (
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ring-1 ring-inset ${
                  metadata.finalDecision === "approved"
                    ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                    : "bg-red-50 text-red-700 ring-red-600/20"
                }`}>
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    {metadata.finalDecision === "approved"
                      ? <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      : <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    }
                  </svg>
                  {metadata.finalDecision.toUpperCase()}
                </span>
              )}
            </div>
          </div>

          {/* Verification Progress */}
          <div className="mt-5 pt-4 border-t border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Verification Progress</span>
              <span className="text-[11px] font-semibold text-gray-700">
                <span className="text-teal-600">{verifCompleted}</span>
                <span className="text-gray-400"> / {verifTypes.length} complete</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all duration-700 ease-out"
                  style={{ width: `${verifProgress}%` }}
                />
              </div>
              <div className="flex items-center gap-1">
                {verifStats.map((v) => {
                  const done = v.status === "success" || v.status === "completed";
                  const failed = v.status === "failed";
                  return (
                    <span
                      key={v.type}
                      title={`${v.type}: ${v.status}`}
                      className={`w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-bold uppercase ring-1 ring-inset ${
                        done ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" :
                        failed ? "bg-red-50 text-red-700 ring-red-600/20" :
                        "bg-gray-50 text-gray-400 ring-gray-200"
                      }`}
                    >
                      {v.type[0]}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Lead Info + Metadata Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Lead Info */}
        <div className="lg:col-span-2 bg-white border border-gray-100 rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-8 h-8 rounded-lg bg-teal-50 flex items-center justify-center ring-1 ring-teal-100">
              <svg className="w-4 h-4 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
            </div>
            <p className="text-sm font-bold text-gray-900">Lead Information</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-5 text-sm">
            {[
              { label: "Full Name", value: lead.name || "—", icon: "user" },
              { label: "Phone", value: lead.phone || "—", icon: "phone" },
              lead.shopName && { label: "Shop", value: lead.shopName, icon: "shop" },
              lead.location && { label: "Location", value: lead.location, icon: "pin" },
              pd?.dob && { label: "DOB", value: pd.dob, icon: "calendar" },
              pd?.fatherHusbandName && { label: "Father / Husband", value: pd.fatherHusbandName, icon: "user" },
              pd?.aadhaarNo && { label: "Aadhaar", value: `XXXX-XXXX-${pd.aadhaarNo.slice(-4)}`, icon: "id", mono: true },
              pd?.panNo && { label: "PAN", value: pd.panNo, icon: "id", mono: true },
              pd?.vehicleRc && { label: "Vehicle RC", value: pd.vehicleRc, icon: "car", mono: true },
              pd?.financeType && { label: "Finance Type", value: pd.financeType, icon: "money" },
              pd?.assetType && { label: "Asset Type", value: pd.assetType, icon: "box" },
            ].filter(Boolean).map((f, i) => {
              const field = f as { label: string; value: string; icon: string; mono?: boolean };
              const iconPath: Record<string, React.ReactNode> = {
                user: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />,
                phone: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />,
                shop: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17" />,
                pin: <><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></>,
                calendar: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
                id: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0h4" />,
                car: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />,
                money: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
                box: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />,
              };
              return (
                <div key={i} className="group">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                    <svg className="w-3 h-3 text-gray-400 group-hover:text-teal-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {iconPath[field.icon]}
                    </svg>
                    {field.label}
                  </p>
                  <p className={`font-semibold text-gray-900 break-words ${field.mono ? "font-mono text-[13px]" : ""}`}>
                    {field.value}
                  </p>
                </div>
              );
            })}
            {pd?.localAddress && (
              <div className="col-span-2 md:col-span-3 pt-2 mt-1 border-t border-gray-100">
                <p className="flex items-center gap-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
                  Address
                </p>
                <p className="font-medium text-gray-800 leading-relaxed">{pd.localAddress}</p>
              </div>
            )}
          </div>
        </div>

        {/* Side Panel: Coupon + Consent + Queue */}
        <div className="space-y-5">
          {/* Coupon */}
          {metadata && (
            <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-50 to-purple-100 flex items-center justify-center ring-1 ring-purple-100">
                  <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
                </div>
                <p className="text-sm font-bold text-gray-900">Coupon & Case</p>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 font-medium">Coupon Code</span>
                  <span className="font-mono font-semibold text-gray-900 bg-gray-50 px-2 py-0.5 rounded border border-gray-200 text-[12px]">{metadata.couponCode || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 font-medium">Status</span>
                  <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ring-1 ring-inset ${
                    metadata.couponStatus === "used" ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" :
                    metadata.couponStatus === "reserved" ? "bg-amber-50 text-amber-700 ring-amber-600/20" :
                    "bg-gray-50 text-gray-600 ring-gray-500/20"
                  }`}>
                    {metadata.couponStatus || "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 font-medium">Case Type</span>
                  <span className="font-semibold text-gray-900 capitalize text-[13px]">{metadata.caseType || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 font-medium">Documents</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-gray-900">
                    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    {metadata.documentsCount || 0}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <span className="text-xs text-gray-500 font-medium">Dealer Edits</span>
                  <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${metadata.dealerEditsLocked ? "text-red-600" : "text-emerald-600"}`}>
                    {metadata.dealerEditsLocked ? (
                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z" /></svg>
                    )}
                    {metadata.dealerEditsLocked ? "Locked" : "Unlocked"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Consent */}
          {consent.length > 0 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 flex items-center justify-center ring-1 ring-blue-100">
                    <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                  </div>
                  <p className="text-sm font-bold text-gray-900">Consent</p>
                </div>
                <span className="text-[10px] font-semibold text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">{consent.length} record{consent.length > 1 ? "s" : ""}</span>
              </div>
              <div className="space-y-2">
                {consent.map((c) => {
                  const pdfUrl = c.signedConsentUrl ?? c.generatedPdfUrl;
                  const isPrimary = c.consentFor === "primary";
                  const isViewable = isPrimary && !!pdfUrl;
                  const isVerified = c.consentStatus === "verified" || c.consentStatus === "digitally_signed";
                  const isRejected = c.consentStatus === "rejected";
                  const isViewed = !!c.adminViewedAt && !isVerified && !isRejected;
                  const canDecide = isViewable && !isVerified && !isRejected;
                  const isConfirmingReject = pendingRejectId === c.id;
                  const isApprovingThis = consentActionLoading === `${c.id}:approve`;
                  const isRejectingThis = consentActionLoading === `${c.id}:reject`;

                  const statusConfig = isVerified
                    ? { dot: "bg-green-500", badge: "bg-green-50 text-green-700 ring-green-600/20", label: "Verified" }
                    : isRejected
                      ? { dot: "bg-red-500", badge: "bg-red-50 text-red-700 ring-red-600/20", label: "Rejected" }
                      : isViewed
                        ? { dot: "bg-blue-500", badge: "bg-blue-50 text-blue-700 ring-blue-600/20", label: "Under Review" }
                        : { dot: "bg-amber-500", badge: "bg-amber-50 text-amber-800 ring-amber-600/20", label: c.consentStatus.replace(/_/g, " ") };

                  const cardBorder = isVerified
                    ? "border-green-200 bg-green-50/30"
                    : isRejected
                      ? "border-red-200 bg-red-50/30"
                      : "border-gray-200 bg-white";

                  const signedRelative = formatRelativeTime(c.signedAt);
                  const verifiedRelative = formatRelativeTime(c.verifiedAt);
                  const viewedRelative = formatRelativeTime(c.adminViewedAt);

                  const metaParts: string[] = [];
                  if (c.consentType) metaParts.push(prettyConsentType(c.consentType));
                  if (signedRelative) metaParts.push(`Signed ${signedRelative}`);
                  if (!isVerified && !isRejected && viewedRelative) metaParts.push(`Viewed ${viewedRelative}`);

                  return (
                    <div
                      key={c.id}
                      className={`border rounded-lg p-3 transition-colors ${cardBorder}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center">
                            <svg className="w-4 h-4 text-gray-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h5.586A2 2 0 0113 2.586L15.414 5A2 2 0 0116 6.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm6 2a.75.75 0 00-1.5 0v3.25H5.25a.75.75 0 000 1.5H8.5V14a.75.75 0 001.5 0v-3.25h3.25a.75.75 0 000-1.5H10V6z" clipRule="evenodd" />
                            </svg>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-sm text-gray-900 truncate">
                                {prettyConsentFor(c.consentFor)}
                              </p>
                              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ring-inset capitalize ${statusConfig.badge}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${statusConfig.dot}`} />
                                {statusConfig.label}
                              </span>
                            </div>
                            {metaParts.length > 0 && (
                              <p className="mt-0.5 text-[11px] text-gray-500 truncate">
                                {metaParts.join(" · ")}
                              </p>
                            )}
                            {isVerified && verifiedRelative && (
                              <p className="mt-0.5 text-[11px] text-green-700">
                                Approved by admin {verifiedRelative}
                              </p>
                            )}
                            {isRejected && verifiedRelative && (
                              <p className="mt-0.5 text-[11px] text-red-700">
                                Rejected by admin {verifiedRelative}
                              </p>
                            )}
                            {isPrimary && !pdfUrl && (
                              <p className="mt-0.5 text-[11px] text-gray-400 italic">
                                PDF not yet generated
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      {(isViewable || canDecide) && (
                        <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2 flex-wrap">
                          {isViewable && (
                            <button
                              type="button"
                              onClick={() => handleConsentClick(c)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                                <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.147.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                              </svg>
                              View PDF
                            </button>
                          )}
                          {canDecide && (
                            <>
                              <button
                                type="button"
                                disabled={consentActionLoading !== null}
                                onClick={() => {
                                  setPendingRejectId(null);
                                  handleConsentVerify(c, "approve");
                                }}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-green-600 text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              >
                                {isApprovingThis ? (
                                  <>
                                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                                      <circle className="opacity-25" cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="3" />
                                      <path className="opacity-75" fill="currentColor" d="M2 10a8 8 0 018-8v3a5 5 0 00-5 5H2z" />
                                    </svg>
                                    Approving…
                                  </>
                                ) : (
                                  <>
                                    <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                                    </svg>
                                    Approve
                                  </>
                                )}
                              </button>
                              {isConfirmingReject ? (
                                <>
                                  <button
                                    type="button"
                                    disabled={consentActionLoading !== null}
                                    onClick={() => handleConsentVerify(c, "reject")}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-red-700 text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                  >
                                    {isRejectingThis ? (
                                      <>
                                        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                                          <circle className="opacity-25" cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="3" />
                                          <path className="opacity-75" fill="currentColor" d="M2 10a8 8 0 018-8v3a5 5 0 00-5 5H2z" />
                                        </svg>
                                        Rejecting…
                                      </>
                                    ) : (
                                      <>Confirm Reject</>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={consentActionLoading !== null}
                                    onClick={() => setPendingRejectId(null)}
                                    className="px-2 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  disabled={consentActionLoading !== null}
                                  onClick={() => setPendingRejectId(c.id)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                  <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                    <path fillRule="evenodd" d="M4.28 3.22a.75.75 0 00-1.06 1.06L8.94 10l-5.72 5.72a.75.75 0 101.06 1.06L10 11.06l5.72 5.72a.75.75 0 101.06-1.06L11.06 10l5.72-5.72a.75.75 0 00-1.06-1.06L10 8.94 4.28 3.22z" clipRule="evenodd" />
                                  </svg>
                                  Reject
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {consentActionError && (
                <div className="mt-3 flex items-start gap-2 p-2 rounded-md bg-red-50 border border-red-200">
                  <svg className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <p className="text-xs text-red-700">{consentActionError}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="inline-flex gap-1 bg-gray-100 p-1.5 rounded-2xl border border-gray-200 shadow-sm">
        <button onClick={() => setActiveTab("verifications")}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
            activeTab === "verifications"
              ? "bg-white text-teal-700 shadow-md ring-1 ring-teal-100"
              : "text-gray-600 hover:text-gray-900 hover:bg-white/60"
          }`}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
          Verification Cards
        </button>
        <button onClick={() => setActiveTab("documents")}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
            activeTab === "documents"
              ? "bg-white text-teal-700 shadow-md ring-1 ring-teal-100"
              : "text-gray-600 hover:text-gray-900 hover:bg-white/60"
          }`}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Documents
          <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
            activeTab === "documents" ? "bg-teal-100 text-teal-700" : "bg-gray-200 text-gray-600"
          }`}>{documents.length}</span>
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
            ocrData={documents.find((d) => d.docType === "pan_card")?.ocrData || null}
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
            ocrData={documents.find((d) => ["bank_statement", "cheque_1", "cheque_2", "cheque_3", "cheque_4"].includes(d.docType) && d.ocrData)?.ocrData || null}
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
            ocrData={documents.find((d) => d.docType === "rc_copy")?.ocrData || null}
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

      {/* Step 3 — Panel 2: Supporting Documents Review (BRD §2.9.3) */}
      {activeTab === "verifications" && data.supportingDocs.length > 0 && (
        <SupportingDocsPanel
          leadId={leadId}
          docs={data.supportingDocs}
          onRefresh={fetchData}
        />
      )}

      {/* Step 3 — Panel 3: Co-Borrower KYC Review (BRD §2.9.3) */}
      {activeTab === "verifications" && data.coBorrower && (
        <CoBorrowerPanel
          leadId={leadId}
          coBorrower={data.coBorrower}
          onRefresh={fetchData}
        />
      )}

      {/* Documents Tab */}
      {activeTab === "documents" && (
        <div>
          {documents.length === 0 ? (
            <div className="bg-gradient-to-br from-gray-50 to-gray-100/50 border-2 border-dashed border-gray-200 rounded-2xl p-12 text-center">
              <div className="w-14 h-14 rounded-2xl bg-white shadow-sm mx-auto mb-3 flex items-center justify-center">
                <svg className="w-7 h-7 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              </div>
              <p className="text-gray-500 font-medium">No documents uploaded yet</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {documents.map((doc) => (
                <button key={doc.id} onClick={() => setLightboxUrl(doc.fileUrl)}
                  className="group bg-white border border-gray-100 rounded-2xl p-3 hover:border-teal-300 hover:shadow-lg hover:-translate-y-0.5 transition-all text-left shadow-sm">
                  <div className="aspect-[4/3] bg-gradient-to-br from-gray-100 to-gray-50 rounded-xl mb-3 overflow-hidden flex items-center justify-center relative ring-1 ring-gray-100">
                    {doc.fileUrl ? (
                      <Image src={doc.fileUrl} alt={doc.docType} fill
                        className="object-cover group-hover:scale-110 transition-transform duration-300" />
                    ) : (
                      <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <p className="text-[13px] font-semibold text-gray-800 truncate group-hover:text-teal-700 transition-colors">
                    {DOC_TYPE_LABELS[doc.docType] || doc.docType}
                  </p>
                  <span className={`inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ring-1 ring-inset capitalize ${
                    doc.verificationStatus === "success" ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" :
                    doc.verificationStatus === "failed" ? "bg-red-50 text-red-700 ring-red-600/20" :
                    doc.verificationStatus === "in_progress" || doc.verificationStatus === "awaiting_action" ? "bg-amber-50 text-amber-700 ring-amber-600/20" :
                    "bg-gray-50 text-gray-600 ring-gray-500/20"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      doc.verificationStatus === "success" ? "bg-emerald-500" :
                      doc.verificationStatus === "failed" ? "bg-red-500" :
                      doc.verificationStatus === "in_progress" || doc.verificationStatus === "awaiting_action" ? "bg-amber-500" :
                      "bg-gray-400"
                    }`} />
                    {doc.verificationStatus.replace(/_/g, " ")}
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

      {/* Consent PDF Viewer */}
      {viewingConsent && (
        <ConsentPdfViewerModal
          open
          onClose={() => setViewingConsent(null)}
          pdfUrl={viewingConsent.signedConsentUrl ?? viewingConsent.generatedPdfUrl ?? ""}
          title={`Consent — ${viewingConsent.consentFor}`}
        />
      )}

      {/* Final Decision Panel */}
      <div className="relative bg-white border border-gray-100 rounded-3xl p-6 md:p-7 sticky bottom-4 shadow-xl ring-1 ring-gray-200/50 overflow-hidden">
        {/* Decorative gradient strip */}
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-teal-500 via-emerald-500 to-blue-500" />

        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-500 flex items-center justify-center shadow-md shadow-teal-500/20">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Final Decision</h2>
              <p className="text-xs text-gray-500">Submit your verdict for this KYC case</p>
            </div>
          </div>
          {isFinalDecided && metadata?.finalDecision && (
            <span className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-bold ring-2 ${
              metadata.finalDecision === "approved"
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-red-50 text-red-700 ring-red-200"
            }`}>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                {metadata.finalDecision === "approved"
                  ? <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  : <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                }
              </svg>
              Already {metadata.finalDecision.toUpperCase()}
            </span>
          )}
        </div>

        {!isFinalDecided ? (
          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Approve */}
              <label className={`relative flex items-start gap-3 p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                decision === "approved"
                  ? "border-emerald-500 bg-gradient-to-br from-emerald-50 to-white shadow-md shadow-emerald-500/10 scale-[1.02]"
                  : "border-gray-200 hover:border-emerald-300 hover:bg-emerald-50/30"
              }`}>
                <input type="radio" name="decision" value="approved"
                  checked={decision === "approved"}
                  onChange={() => setDecision("approved")}
                  className="sr-only" />
                <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
                  decision === "approved" ? "bg-emerald-500 text-white" : "bg-emerald-100 text-emerald-600"
                }`}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-gray-900">Approve Lead</p>
                  <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">
                    {data.coBorrower || data.supportingDocs.length > 0
                      ? "Step 3 cleared — Step 4 unlocks"
                      : "KYC verified, coupon consumed"}
                  </p>
                </div>
                {decision === "approved" && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                  </div>
                )}
              </label>

              {/* Reject */}
              <label className={`relative flex items-start gap-3 p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                decision === "rejected"
                  ? "border-red-500 bg-gradient-to-br from-red-50 to-white shadow-md shadow-red-500/10 scale-[1.02]"
                  : "border-gray-200 hover:border-red-300 hover:bg-red-50/30"
              }`}>
                <input type="radio" name="decision" value="rejected"
                  checked={decision === "rejected"}
                  onChange={() => setDecision("rejected")}
                  className="sr-only" />
                <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
                  decision === "rejected" ? "bg-red-500 text-white" : "bg-red-100 text-red-600"
                }`}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-gray-900">Reject Lead</p>
                  <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">Lead closed permanently</p>
                </div>
                {decision === "rejected" && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                  </div>
                )}
              </label>

              {/* Dealer Action */}
              {(data.coBorrower || data.supportingDocs.length > 0) && (
                <label className={`relative flex items-start gap-3 p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                  decision === "dealer_action_required"
                    ? "border-amber-500 bg-gradient-to-br from-amber-50 to-white shadow-md shadow-amber-500/10 scale-[1.02]"
                    : "border-gray-200 hover:border-amber-300 hover:bg-amber-50/30"
                }`}>
                  <input type="radio" name="decision" value="dealer_action_required"
                    checked={decision === "dealer_action_required"}
                    onChange={() => setDecision("dealer_action_required")}
                    className="sr-only" />
                  <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
                    decision === "dealer_action_required" ? "bg-amber-500 text-white" : "bg-amber-100 text-amber-600"
                  }`}>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-gray-900">Dealer Action</p>
                    <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">Route back to dealer for fixes</p>
                  </div>
                  {decision === "dealer_action_required" && (
                    <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center">
                      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    </div>
                  )}
                </label>
              )}
            </div>

            {decision === "rejected" && (
              <div className="bg-red-50/50 border border-red-100 rounded-xl p-4">
                <label className="flex items-center gap-1.5 text-[11px] font-bold text-red-700 uppercase tracking-wider mb-2">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                  Rejection Reason *
                </label>
                <textarea value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} rows={2}
                  placeholder="Why is this being rejected?"
                  className="w-full text-sm border border-red-200 bg-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition" />
              </div>
            )}

            <div>
              <label className="flex items-center gap-1.5 text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                Notes (optional)
              </label>
              <textarea value={decisionNotes} onChange={(e) => setDecisionNotes(e.target.value)} rows={2}
                placeholder="Additional notes…"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition" />
            </div>

            <div className="flex flex-wrap gap-3 items-center">
              <button onClick={handleFinalDecision} disabled={!decision || decisionLoading}
                className={`inline-flex items-center gap-2 px-8 py-3 rounded-xl text-sm font-bold text-white shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none ${
                  decision === "approved"
                    ? "bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 shadow-emerald-500/30"
                    : decision === "rejected"
                      ? "bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 shadow-red-500/30"
                      : decision === "dealer_action_required"
                        ? "bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 shadow-amber-500/30"
                        : "bg-gray-300 !text-gray-500 !shadow-none"
                }`}>
                {decisionLoading ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    Submitting…
                  </>
                ) : (
                  <>
                    Submit Decision
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                  </>
                )}
              </button>
              <Link href="/admin/kyc-review"
                className="inline-flex items-center gap-1.5 px-5 py-3 rounded-xl text-sm font-semibold bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                Back to Queue
              </Link>
            </div>

            {decisionResult && (
              <div className={`flex items-start gap-2 rounded-xl p-3 text-sm border ${
                decisionResult.success
                  ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                  : "bg-red-50 text-red-800 border-red-200"
              }`}>
                <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  {decisionResult.success
                    ? <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    : <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  }
                </svg>
                <span className="font-medium">{decisionResult.message}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex gap-3">
            <Link href="/admin/kyc-review"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold bg-gradient-to-r from-teal-500 to-emerald-500 hover:from-teal-600 hover:to-emerald-600 text-white shadow-lg shadow-teal-500/30 transition-all">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
              Back to Queue
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
