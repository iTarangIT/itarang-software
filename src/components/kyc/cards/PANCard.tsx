"use client";

import { useState } from "react";

interface PANCardProps {
  leadId: string;
  leadName: string;
  panNumber?: string;
  dob?: string;
  existingVerification?: {
    id: string;
    status: string;
    adminAction?: string | null;
    adminActionNotes?: string | null;
    matchScore?: string | null;
    apiResponse?: Record<string, unknown> | null;
  } | null;
  onActionComplete?: () => void;
}

interface CrossMatchField {
  field: string;
  leadValue: string | null;
  panValue: string | null;
  aadhaarValue: string | null;
  // backward compat
  apiValue?: string | null;
  matchScore: number | null;
  pass: boolean;
}

type CardStatus = "pending" | "loading" | "success" | "failed";

export default function PANCard({
  leadId,
  leadName,
  panNumber,
  dob,
  existingVerification,
  onActionComplete,
}: PANCardProps) {
  const [pan, setPan] = useState(panNumber || "");
  const [status, setStatus] = useState<CardStatus>(() => {
    if (existingVerification?.adminAction === "accepted") return "success";
    if (existingVerification?.adminAction === "rejected") return "failed";
    if (existingVerification?.status === "success") return "success";
    if (existingVerification?.status === "failed") return "failed";
    return "pending";
  });
  const [crossMatchFields, setCrossMatchFields] = useState<CrossMatchField[]>(() => {
    const resp = existingVerification?.apiResponse;
    const d = resp?.data as Record<string, unknown> | undefined;
    const fields = d?.crossMatchFields as CrossMatchField[] | undefined;
    return fields || [];
  });
  const [error, setError] = useState("");
  const [message, setMessage] = useState(() => {
    const resp = existingVerification?.apiResponse;
    return (resp?.message as string) || "";
  });
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");

  const handleVerify = async () => {
    if (!pan.trim()) { setError("PAN number is required"); return; }
    setStatus("loading");
    setError("");
    setMessage("");
    setCrossMatchFields([]);

    // https://in.staging.decentro.tech/kyc/public_registry/validate

    try {
      const res = await fetch(`/api/kyc/${leadId}/decentro/pan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pan_number: pan.trim().toUpperCase(), dob }),
      });
      const data = await res.json();

      if (data.data?.crossMatchFields) {
        setCrossMatchFields(data.data.crossMatchFields);
      }
      setMessage(data.message || "");
      setStatus(data.success ? "success" : "failed");
      if (!data.success) setError(data.message || data.error || "PAN verification failed");
    } catch {
      setStatus("failed");
      setError("Network error. Please try again.");
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
        if (action === "accept") setStatus("success");
        else if (action === "reject") setStatus("failed");
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

  const getMatchBadge = (score: number | null, pass: boolean) => {
    if (score === null) return <span className="text-gray-400 text-xs">N/A</span>;
    if (score >= 80 && pass) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          {score}% Strong Match
        </span>
      );
    }
    if (pass) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-yellow-700">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
          {score}% Weak Match
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        {score}% Mismatch
      </span>
    );
  };

  const statusConfig: Record<CardStatus, { bg: string; label: string }> = {
    pending: { bg: "bg-gray-100 text-gray-600", label: "Pending" },
    loading: { bg: "bg-blue-100 text-blue-700", label: "Verifying..." },
    success: { bg: "bg-green-100 text-green-700", label: "Verified" },
    failed: { bg: "bg-red-100 text-red-700", label: "Failed" },
  };

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-teal-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-teal-600 flex items-center justify-center text-white font-bold text-sm">P</div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">PAN Verification</h3>
            <p className="text-xs text-gray-500">via Decentro Public Registry</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusConfig[status].bg}`}>
          {statusConfig[status].label}
        </span>
      </div>

      <div className="p-5 space-y-5">
        {/* Input: PAN Number Only */}
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Input Data</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500">PAN Number</label>
              <input
                type="text"
                value={pan}
                onChange={(e) => setPan(e.target.value.toUpperCase())}
                placeholder="e.g. ABCDE1234F"
                maxLength={10}
                disabled={status === "loading"}
                className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm uppercase font-mono tracking-wider focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Lead Name (auto)</label>
              <input
                type="text"
                value={leadName}
                disabled
                className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-500"
              />
            </div>
          </div>
        </div>

        {/* Run Button */}
        {(status === "pending" || status === "failed") && (
          <button
            onClick={handleVerify}
            disabled={!pan.trim()}
            className="w-full bg-teal-600 hover:bg-teal-700 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
          >
            Run PAN Verification
          </button>
        )}

        {/* Loading */}
        {status === "loading" && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600" />
            <span className="ml-3 text-sm text-gray-600">Verifying PAN...</span>
          </div>
        )}

        {/* Cross-Match Table (BRD: Field Name | As per Lead | PAN Card | Aadhaar | Match Result) */}
        {crossMatchFields.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">
              Verification Match Results
            </p>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Field Name</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">As per Lead</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">PAN Card</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Aadhaar</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Match Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {crossMatchFields.map((f) => (
                    <tr key={f.field} className={`hover:bg-gray-50/50 ${!f.pass && f.matchScore !== null ? "bg-red-50/30" : ""}`}>
                      <td className="px-3 py-2.5 font-semibold text-gray-800">{f.field}</td>
                      <td className="px-3 py-2.5 text-gray-600 max-w-[140px] truncate">
                        {f.leadValue || <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600 max-w-[140px] truncate font-mono text-xs">
                        {(f.panValue ?? f.apiValue) || <span className="text-gray-300 italic text-[10px]">Not in response</span>}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600 max-w-[140px] truncate font-mono text-xs">
                        {f.aadhaarValue || <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {getMatchBadge(f.matchScore, f.pass)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Result Message */}
        {message && status !== "pending" && status !== "loading" && (
          <div className={`rounded-lg p-3 text-sm ${
            status === "success"
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}>
            {message}
          </div>
        )}

        {/* Retry */}
        {status === "failed" && crossMatchFields.length === 0 && (
          <button
            onClick={() => { setStatus("pending"); setError(""); }}
            className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Retry
          </button>
        )}

        {/* Admin Actions */}
        {(status === "success" || status === "failed") && existingVerification?.id && (
          <div className="space-y-3 pt-3 border-t border-gray-100">
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Admin Notes</label>
              <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                placeholder="PAN verification remarks..."
                className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-teal-500 focus:border-teal-500" />
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
              <button onClick={() => handleAdminAction("request_more_docs")} disabled={!!actionLoading}
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                {actionLoading === "request_more_docs" ? "..." : "Request Docs"}
              </button>
            </div>
          </div>
        )}

        {error && !message && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{error}</div>
        )}
      </div>
    </div>
  );
}
