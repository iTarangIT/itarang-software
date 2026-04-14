"use client";

import { useState } from "react";
import ManualDecisionSection from "./ManualDecisionSection";
import RequestCoBorrowerModal from "../step3/RequestCoBorrowerModal";
import RequestMoreDocsModal from "../step3/RequestMoreDocsModal";

interface CIBILCardProps {
  leadId: string;
  leadName: string;
  panNumber?: string;
  dob?: string;
  phone?: string;
  address?: string;
  applicant?: "primary" | "co_borrower";
  existingVerification?: {
    id: string;
    status: string;
    matchScore?: string | null;
    adminAction?: string | null;
    adminActionNotes?: string | null;
    apiResponse?: Record<string, unknown> | null;
  } | null;
  onActionComplete?: () => void;
}

interface CibilInterpretation {
  rating: string;
  riskLevel: string;
  coBorrowerRequired: boolean;
  color: string;
  description: string;
}

interface CibilSummary {
  activeLoans: number | null;
  totalOutstanding: string | null;
  creditUtilization: string | null;
  paymentDefaults: number | null;
  recentEnquiries: number | null;
  oldestAccountAge: string | null;
  creditMix: string | null;
}

type CardStatus = "pending" | "loading_score" | "loading_report" | "success" | "no_history" | "failed";

export default function CIBILCard({
  leadId,
  leadName,
  panNumber,
  dob,
  phone,
  address,
  applicant = "primary",
  existingVerification,
  onActionComplete,
}: CIBILCardProps) {
  const apiBase =
    applicant === "co_borrower"
      ? `/api/admin/kyc/${leadId}/coborrower`
      : `/api/admin/kyc/${leadId}`;
  const [status, setStatus] = useState<CardStatus>(() => {
    if (existingVerification?.adminAction === "accepted") return "success";
    if (existingVerification?.adminAction === "rejected") return "failed";
    if (existingVerification?.status === "success") {
      // Check if it was a "consumer not found" result
      const d = existingVerification?.apiResponse?.data as Record<string, unknown> | undefined;
      if (d?.consumerNotFound) return "no_history";
      return existingVerification?.matchScore ? "success" : "no_history";
    }
    if (existingVerification?.status === "failed") return "failed";
    return "pending";
  });
  const [score, setScore] = useState<number | null>(
    existingVerification?.matchScore ? Number(existingVerification.matchScore) : null
  );
  const [interpretation, setInterpretation] = useState<CibilInterpretation | null>(() => {
    const d = existingVerification?.apiResponse?.data as Record<string, unknown> | undefined;
    return (d?.interpretation as CibilInterpretation) || null;
  });
  const [summary, setSummary] = useState<CibilSummary | null>(() => {
    const d = existingVerification?.apiResponse?.data as Record<string, unknown> | undefined;
    return (d?.summary as CibilSummary) || null;
  });
  const [reportId, setReportId] = useState(() => {
    const d = existingVerification?.apiResponse?.data as Record<string, unknown> | undefined;
    return (d?.reportId as string) || "";
  });
  const [generatedAt, setGeneratedAt] = useState(() => {
    const d = existingVerification?.apiResponse?.data as Record<string, unknown> | undefined;
    return (d?.generatedAt as string) || "";
  });
  const [verificationId, setVerificationId] = useState(existingVerification?.id || "");
  const [error, setError] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [showCoBorrowerModal, setShowCoBorrowerModal] = useState(false);
  const [showMoreDocsModal, setShowMoreDocsModal] = useState(false);

  const handleFetch = async (type: "score" | "report") => {
    setStatus(type === "score" ? "loading_score" : "loading_report");
    setError("");

    const endpoint = type === "score"
      ? `${apiBase}/cibil/score`
      : `${apiBase}/cibil/report`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        setError(`API returned ${res.status}. Please restart dev server.`);
        setStatus("failed");
        return;
      }
      const data = await res.json();

      // Store verification ID for admin actions
      if (data.data?.verificationId) setVerificationId(data.data.verificationId);
      if (data.data?.reportId) setReportId(data.data.reportId);
      if (data.data?.generatedAt) setGeneratedAt(data.data.generatedAt);

      if (data.success && data.data?.score !== null && data.data?.score !== undefined) {
        // Score found
        setScore(data.data.score);
        setInterpretation(data.data.interpretation);
        if (data.data.summary) setSummary(data.data.summary);
        setStatus("success");
      } else if (data.data?.consumerNotFound || data.success) {
        // Consumer not found in bureau — valid result, no credit history
        setScore(null);
        setStatus("no_history");
      } else {
        // Actual API failure
        const rawKey = data.data?.rawResponse?.responseKey || "";
        const rawMsg = data.data?.rawResponse?.message || data.error?.message || "";
        if (rawKey === "error_credits_score_not_found" && type === "score") {
          setError("Credit score not found via basic lookup. Try 'Get Report' for a full credit bureau search using PAN & DOB.");
        } else {
          setError(rawMsg || "Failed to fetch CIBIL data");
        }
        setStatus("failed");
      }
    } catch {
      setError("Network error. Please try again.");
      setStatus("failed");
    }
  };

  const handleAdminAction = async (action: "accept" | "reject" | "request_more_docs") => {
    const vid = verificationId || existingVerification?.id;
    if (!vid) return;
    if (action === "reject" && !adminNotes.trim()) { setError("Please add rejection reason"); return; }
    setActionLoading(action);
    setError("");
    try {
      const res = await fetch(`/api/admin/kyc/${leadId}/verification/${vid}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, notes: adminNotes, rejection_reason: action === "reject" ? adminNotes : undefined }),
      });
      const data = await res.json();
      if (data.success) {
        onActionComplete?.();
      } else {
        setError(data.error?.message || "Action failed");
      }
    } catch {
      setError("Network error");
    } finally {
      setActionLoading("");
    }
  };

  const statusLabel: Record<CardStatus, { bg: string; label: string }> = {
    pending: { bg: "bg-gray-100 text-gray-600", label: "Pending" },
    loading_score: { bg: "bg-blue-100 text-blue-700", label: "Fetching Score..." },
    loading_report: { bg: "bg-blue-100 text-blue-700", label: "Fetching Report..." },
    success: { bg: "bg-green-100 text-green-700", label: "Score Received" },
    no_history: { bg: "bg-amber-100 text-amber-700", label: "No Credit History" },
    failed: { bg: "bg-red-100 text-red-700", label: "Failed" },
  };

  const scoreColor = !score ? "text-gray-400"
    : score >= 750 ? "text-green-600"
    : score >= 700 ? "text-blue-600"
    : score >= 650 ? "text-yellow-600"
    : "text-red-600";

  const riskCategory = !score ? ""
    : score >= 750 ? "LOW"
    : score >= 700 ? "LOW"
    : score >= 650 ? "MODERATE"
    : "HIGH";

  const isLoading = status === "loading_score" || status === "loading_report";
  const hasScoreResults = score !== null && !isLoading;

  // Format phone for display: strip country code prefix for display
  const displayPhone = phone
    ? `+91 ${phone.replace(/^\+?91/, "").replace(/\D/g, "")}`
    : "Not available";

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-purple-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-600 flex items-center justify-center text-white font-bold text-sm">C</div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">CIBIL Credit Score</h3>
            <p className="text-xs text-gray-500">via Decentro</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusLabel[status].bg}`}>
          {statusLabel[status].label}
        </span>
      </div>

      <div className="p-5 space-y-5">
        {/* INPUT DATA (From Lead) */}
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Input Data (From Lead)</p>
          <div className="space-y-1.5 text-sm">
            <div className="flex gap-2">
              <span className="text-gray-400 w-16 shrink-0">Name:</span>
              <span className="font-medium text-gray-800">{leadName || "—"}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-gray-400 w-16 shrink-0">PAN:</span>
              <span className="font-medium text-gray-800 font-mono">{panNumber || "Not available"}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-gray-400 w-16 shrink-0">DOB:</span>
              <span className="font-medium text-gray-800">{dob || "Not available"}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-gray-400 w-16 shrink-0">Mobile:</span>
              <span className="font-medium text-gray-800">{displayPhone}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-gray-400 w-16 shrink-0">Address:</span>
              <span className="font-medium text-gray-800">{address || "Not available"}</span>
            </div>
          </div>
        </div>

        {/* Manual Override — available until an admin decision is captured */}
        {status === "pending" && !verificationId && !existingVerification?.id && (
          <ManualDecisionSection
            leadId={leadId}
            verificationType="cibil"
            applicant={applicant}
            onActionComplete={onActionComplete}
          />
        )}

        {/* VERIFICATION OPTIONS — show when pending or failed */}
        {(status === "pending" || status === "failed") && (
          <div>
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Verification Options</p>
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Report Type</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Cost</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="px-4 py-3 text-gray-800">Credit Score Only</td>
                    <td className="px-4 py-3 text-gray-600 font-mono">&#8377;4.00</td>
                    <td className="px-4 py-3">
                      <button onClick={() => handleFetch("score")}
                        className="px-4 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-medium transition-colors">
                        Get Score
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-gray-800">Credit Report Summary</td>
                    <td className="px-4 py-3 text-gray-600 font-mono">&#8377;20.00</td>
                    <td className="px-4 py-3">
                      <button onClick={() => handleFetch("report")}
                        className="px-4 py-1.5 bg-purple-800 hover:bg-purple-900 text-white rounded-lg text-xs font-medium transition-colors">
                        Get Report
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600" />
            <span className="ml-3 text-sm text-gray-600">
              Fetching CIBIL {status === "loading_report" ? "report" : "score"}...
            </span>
          </div>
        )}

        {/* NO CREDIT HISTORY RESULT */}
        {status === "no_history" && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide">Verification Result</p>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-5 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                </div>
                <div>
                  <p className="text-base font-semibold text-amber-800">No Credit History Found</p>
                  <p className="text-sm text-amber-700">Consumer not found in credit bureau</p>
                </div>
              </div>

              <div className="text-sm text-amber-700 space-y-1 pl-[52px]">
                <p>This person has no credit history with CIBIL/TransUnion. This typically means:</p>
                <ul className="list-disc list-inside space-y-0.5 text-amber-600">
                  <li>No previous loans or credit cards</li>
                  <li>First-time borrower (NTC - New to Credit)</li>
                  <li>Credit history may exist under a different name/PAN</li>
                </ul>
              </div>

              {reportId && (
                <div className="text-xs text-amber-500 pt-2 border-t border-amber-200 pl-[52px]">
                  Report ID: {reportId}
                  {generatedAt && (
                    <span className="ml-3">
                      Checked: {new Date(generatedAt).toLocaleString("en-IN", {
                        day: "2-digit", month: "short", year: "numeric",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-700">
              <span className="font-semibold">Recommendation:</span> Since no CIBIL score exists, consider requiring a co-borrower with established credit history, or proceed with alternative assessment.
            </div>

            {/* Admin actions for no_history */}
            {verificationId && (
              <div className="space-y-3 pt-3 border-t border-gray-100">
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Admin Notes</p>
                  <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                    placeholder="CIBIL verification remarks..."
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Admin Decision</p>
                  <div className="flex gap-2">
                    <button onClick={() => handleAdminAction("accept")} disabled={!!actionLoading}
                      className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                      {actionLoading === "accept" ? "..." : "Accept (Proceed without CIBIL)"}
                    </button>
                    <button onClick={() => handleAdminAction("reject")} disabled={!!actionLoading}
                      className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                      {actionLoading === "reject" ? "..." : "Reject"}
                    </button>
                    <button onClick={() => setShowCoBorrowerModal(true)} disabled={!!actionLoading}
                      className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                      Need Co-Borrower KYC
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SCORE RESULTS */}
        {hasScoreResults && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide">
              Verification Results {summary ? "" : "(Score Only)"}
            </p>

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
              {/* Score */}
              <div className="flex items-baseline gap-3">
                <span className="text-sm text-gray-500 font-semibold">CIBIL SCORE:</span>
                <span className={`text-3xl font-bold ${scoreColor}`}>{score}</span>
              </div>

              {/* Risk Category */}
              <div className="text-sm">
                <span className="text-gray-500">Risk Category: </span>
                <span className={`font-semibold ${
                  riskCategory === "LOW" ? "text-green-700" :
                  riskCategory === "MODERATE" ? "text-yellow-700" :
                  "text-red-700"
                }`}>{riskCategory}</span>
              </div>

              {/* Report metadata */}
              {reportId && (
                <div className="text-xs text-gray-500">
                  Credit Report ID: {reportId}
                </div>
              )}
              {generatedAt && (
                <div className="text-xs text-gray-500">
                  Generated: {new Date(generatedAt).toLocaleString("en-IN", {
                    day: "2-digit", month: "short", year: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  })}
                </div>
              )}

              {/* Score Interpretation */}
              <div className="pt-2 border-t border-gray-200">
                <p className="text-xs font-semibold text-gray-600 mb-2">Score Interpretation:</p>
                <div className="space-y-1 text-xs text-gray-600">
                  <p className={score && score >= 750 ? "font-bold text-green-700" : ""}>750+ = Excellent (Low Risk)</p>
                  <p className={score && score >= 700 && score < 750 ? "font-bold text-blue-700" : ""}>700-749 = Good (Low Risk)</p>
                  <p className={score && score >= 650 && score < 700 ? "font-bold text-yellow-700" : ""}>650-699 = Moderate (Medium Risk)</p>
                  <p className={score && score < 650 ? "font-bold text-red-700" : ""}>&lt;650 = Poor (High Risk) → Co-borrower needed</p>
                </div>
              </div>

              {interpretation?.coBorrowerRequired && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 font-semibold">
                  Co-borrower KYC required for this score range.
                </div>
              )}
            </div>

            {/* SUMMARY DATA (if Full Report run) */}
            {summary && (
              <div>
                <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Summary Data (Full Report)</p>
                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-100">
                      {[
                        { label: "Active Loans", value: summary.activeLoans },
                        { label: "Total Outstanding", value: summary.totalOutstanding },
                        { label: "Credit Utilization", value: summary.creditUtilization },
                        { label: "Payment Defaults", value: summary.paymentDefaults },
                        { label: "Recent Enquiries (30 days)", value: summary.recentEnquiries },
                        { label: "Oldest Account Age", value: summary.oldestAccountAge },
                        { label: "Credit Mix", value: summary.creditMix },
                      ].map((row) => (
                        <tr key={row.label} className="hover:bg-gray-50/50">
                          <td className="px-4 py-2.5 text-gray-600">{row.label}</td>
                          <td className="px-4 py-2.5 font-medium text-gray-800 text-right">
                            {row.value !== null && row.value !== undefined ? String(row.value) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Upgrade to full report if only had score */}
            {!summary && status === "success" && (
              <div className="overflow-hidden rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <tbody>
                    <tr>
                      <td className="px-4 py-3 text-gray-800">Credit Report Summary</td>
                      <td className="px-4 py-3 text-gray-600 font-mono">&#8377;20.00</td>
                      <td className="px-4 py-3">
                        <button onClick={() => handleFetch("report")}
                          className="px-4 py-1.5 bg-purple-800 hover:bg-purple-900 text-white rounded-lg text-xs font-medium transition-colors">
                          Get Report
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* ADMIN NOTES */}
            {(existingVerification?.id || verificationId) && (
              <div className="space-y-3 pt-3 border-t border-gray-100">
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Admin Notes</p>
                  <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                    placeholder="CIBIL verification remarks..."
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500" />
                </div>

                {/* ADMIN DECISION */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Admin Decision</p>
                  <div className="flex gap-2">
                    <button onClick={() => handleAdminAction("accept")} disabled={!!actionLoading}
                      className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                      {actionLoading === "accept" ? "..." : "Accept"}
                    </button>
                    <button onClick={() => handleAdminAction("reject")} disabled={!!actionLoading}
                      className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                      {actionLoading === "reject" ? "..." : "Reject"}
                    </button>
                    {interpretation?.coBorrowerRequired && (
                      <button onClick={() => setShowCoBorrowerModal(true)} disabled={!!actionLoading}
                        className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                        Need Co-Borrower KYC
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{error}</div>}
      </div>

      <RequestCoBorrowerModal
        open={showCoBorrowerModal}
        onClose={() => setShowCoBorrowerModal(false)}
        leadId={leadId}
        onSuccess={() => onActionComplete?.()}
      />
      <RequestMoreDocsModal
        open={showMoreDocsModal}
        onClose={() => setShowMoreDocsModal(false)}
        leadId={leadId}
        sourceVerificationId={verificationId || existingVerification?.id || null}
        sourceCardLabel="CIBIL Verification"
        onSuccess={() => onActionComplete?.()}
      />
    </div>
  );
}
