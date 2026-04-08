"use client";

import { useState } from "react";

interface CIBILCardProps {
  leadId: string;
  leadName: string;
  panNumber?: string;
  existingVerification?: {
    id: string;
    status: string;
    matchScore?: string | null;
    adminAction?: string | null;
    adminActionNotes?: string | null;
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

type CardStatus = "pending" | "loading" | "success" | "failed";
type ReportType = "score" | "report";

export default function CIBILCard({
  leadId,
  leadName,
  panNumber,
  existingVerification,
  onActionComplete,
}: CIBILCardProps) {
  const [status, setStatus] = useState<CardStatus>(() => {
    if (existingVerification?.adminAction === "accepted") return "success";
    if (existingVerification?.adminAction === "rejected") return "failed";
    if (existingVerification?.status === "success") return "success";
    if (existingVerification?.status === "failed") return "failed";
    return "pending";
  });
  const [score, setScore] = useState<number | null>(
    existingVerification?.matchScore ? Number(existingVerification.matchScore) : null
  );
  const [interpretation, setInterpretation] = useState<CibilInterpretation | null>(null);
  const [summary, setSummary] = useState<CibilSummary | null>(null);
  const [reportId, setReportId] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");
  const [error, setError] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [reportType, setReportType] = useState<ReportType>("score");

  const handleFetch = async (type: ReportType) => {
    setStatus("loading");
    setError("");
    setReportType(type);

    const endpoint = type === "score"
      ? `/api/admin/kyc/${leadId}/cibil/score`
      : `/api/admin/kyc/${leadId}/cibil/report`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();

      if (data.success || data.data?.score) {
        setScore(data.data.score);
        setInterpretation(data.data.interpretation);
        setReportId(data.data.reportId || "");
        setGeneratedAt(data.data.generatedAt || "");
        if (data.data.summary) setSummary(data.data.summary);
        setStatus("success");
      } else {
        setError(data.error?.message || "Failed to fetch CIBIL data");
        setStatus("failed");
      }
    } catch {
      setError("Network error. Please try again.");
      setStatus("failed");
    }
  };

  const handleAdminAction = async (action: "accept" | "reject" | "request_more_docs") => {
    if (!existingVerification?.id) return;
    if (action === "reject" && !adminNotes.trim()) { setError("Please add rejection reason"); return; }
    setActionLoading(action);
    setError("");
    try {
      const res = await fetch(`/api/admin/kyc/${leadId}/verification/${existingVerification.id}/action`, {
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

  const getScoreColor = () => {
    if (!score) return "text-gray-400";
    if (score >= 750) return "text-green-600";
    if (score >= 700) return "text-blue-600";
    if (score >= 650) return "text-yellow-600";
    return "text-red-600";
  };

  const getScoreBarWidth = () => {
    if (!score) return "0%";
    return `${Math.min(100, Math.max(0, ((score - 300) / 600) * 100))}%`;
  };

  const getRiskBadge = () => {
    if (!interpretation) return null;
    const colorMap: Record<string, string> = {
      green: "bg-green-100 text-green-700",
      blue: "bg-blue-100 text-blue-700",
      yellow: "bg-yellow-100 text-yellow-700",
      red: "bg-red-100 text-red-700",
    };
    return (
      <span className={`px-3 py-1 rounded-full text-xs font-semibold ${colorMap[interpretation.color] || "bg-gray-100 text-gray-600"}`}>
        {interpretation.rating} - {interpretation.riskLevel} Risk
      </span>
    );
  };

  const statusConfig: Record<CardStatus, { bg: string; label: string }> = {
    pending: { bg: "bg-gray-100 text-gray-600", label: "Pending" },
    loading: { bg: "bg-blue-100 text-blue-700", label: "Fetching..." },
    success: { bg: "bg-green-100 text-green-700", label: "Score Received" },
    failed: { bg: "bg-red-100 text-red-700", label: "Failed" },
  };

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
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusConfig[status].bg}`}>
          {statusConfig[status].label}
        </span>
      </div>

      <div className="p-5 space-y-5">
        {/* Input Info */}
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Input Data</p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-gray-400">Name</p>
              <p className="font-medium text-gray-800">{leadName}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">PAN</p>
              <p className="font-medium text-gray-800">{panNumber || "Not available"}</p>
            </div>
          </div>
        </div>

        {/* Fetch Buttons */}
        {status === "pending" && (
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => handleFetch("score")}
              className="bg-purple-600 hover:bg-purple-700 text-white py-2.5 rounded-lg text-sm font-medium transition-colors">
              <span className="block text-sm">Get Score Only</span>
              <span className="block text-xs opacity-75 mt-0.5">~Rs.4.00</span>
            </button>
            <button onClick={() => handleFetch("report")}
              className="bg-purple-800 hover:bg-purple-900 text-white py-2.5 rounded-lg text-sm font-medium transition-colors">
              <span className="block text-sm">Get Full Report</span>
              <span className="block text-xs opacity-75 mt-0.5">~Rs.20.00</span>
            </button>
          </div>
        )}

        {status === "loading" && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600" />
            <span className="ml-3 text-sm text-gray-600">
              Fetching CIBIL {reportType === "report" ? "report" : "score"}...
            </span>
          </div>
        )}

        {/* Score Display */}
        {score !== null && status !== "loading" && (
          <div className="space-y-4">
            <div className="text-center py-4">
              <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-2">Credit Score</p>
              <p className={`text-5xl font-bold ${getScoreColor()}`}>{score}</p>
              {/* Score bar */}
              <div className="mt-3 mx-auto max-w-xs">
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: getScoreBarWidth(),
                      background: `linear-gradient(90deg, #ef4444, #eab308, #22c55e)`,
                    }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>300</span>
                  <span>500</span>
                  <span>700</span>
                  <span>900</span>
                </div>
              </div>
              <div className="mt-3">{getRiskBadge()}</div>
            </div>

            {/* Interpretation */}
            {interpretation && (
              <div className={`rounded-lg p-4 ${
                interpretation.color === "green" ? "bg-green-50 border border-green-200" :
                interpretation.color === "blue" ? "bg-blue-50 border border-blue-200" :
                interpretation.color === "yellow" ? "bg-yellow-50 border border-yellow-200" :
                "bg-red-50 border border-red-200"
              }`}>
                <p className="text-sm">{interpretation.description}</p>
                {interpretation.coBorrowerRequired && (
                  <p className="text-sm font-semibold mt-2 text-red-700">
                    Co-borrower KYC required for this score range.
                  </p>
                )}
              </div>
            )}

            {/* Report Summary */}
            {summary && (
              <div>
                <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Credit Report Summary</p>
                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-100">
                      {[
                        { label: "Active Loans", value: summary.activeLoans },
                        { label: "Total Outstanding", value: summary.totalOutstanding },
                        { label: "Credit Utilization", value: summary.creditUtilization },
                        { label: "Payment Defaults", value: summary.paymentDefaults },
                        { label: "Recent Enquiries (30d)", value: summary.recentEnquiries },
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

            {/* Metadata */}
            <div className="flex items-center gap-4 text-xs text-gray-400">
              {reportId && <span>Report ID: {reportId}</span>}
              {generatedAt && <span>Generated: {new Date(generatedAt).toLocaleString()}</span>}
            </div>

            {/* Retry: Get full report if only had score */}
            {!summary && status === "success" && (
              <button onClick={() => handleFetch("report")}
                className="w-full bg-purple-100 hover:bg-purple-200 text-purple-700 py-2 rounded-lg text-sm font-medium transition-colors">
                Upgrade to Full Report (~Rs.20.00)
              </button>
            )}

            {/* Admin Actions */}
            {existingVerification?.id && (
              <div className="space-y-3 pt-3 border-t border-gray-100">
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Admin Notes</label>
                  <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                    placeholder="CIBIL verification remarks..."
                    className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500" />
                </div>
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
                    <button onClick={() => handleAdminAction("request_more_docs")} disabled={!!actionLoading}
                      className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                      {actionLoading === "request_more_docs" ? "..." : "Need Co-Borrower"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{error}</div>}
      </div>
    </div>
  );
}
