"use client";

import { useState } from "react";
import OcrAutofillButton from "./OcrAutofillButton";
import RequestMoreDocsModal from "../step3/RequestMoreDocsModal";

interface RCCardProps {
  leadId: string;
  rcNumber?: string;
  ocrData?: Record<string, unknown> | null;
  applicant?: "primary" | "co_borrower";
  existingVerification?: {
    id: string;
    status: string;
    adminAction?: string | null;
    adminActionNotes?: string | null;
    apiResponse?: Record<string, unknown> | null;
  } | null;
  onActionComplete?: () => void;
}

type CardStatus = "pending" | "loading" | "success" | "failed";

export default function RCCard({
  leadId,
  rcNumber: initRc = "",
  ocrData,
  applicant = "primary",
  existingVerification,
  onActionComplete,
}: RCCardProps) {
  const apiBase =
    applicant === "co_borrower"
      ? `/api/admin/kyc/${leadId}/coborrower`
      : `/api/admin/kyc/${leadId}`;
  const [rcNumber, setRcNumber] = useState(initRc);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<CardStatus>(() => {
    if (existingVerification?.adminAction === "accepted") return "success";
    if (existingVerification?.adminAction === "rejected") return "failed";
    if (existingVerification?.status === "success") return "success";
    if (existingVerification?.status === "failed") return "failed";
    return "pending";
  });
  const [chassisNumber, setChassisNumber] = useState<string | null>(() => {
    const resp = existingVerification?.apiResponse;
    const d = resp?.data as Record<string, unknown> | undefined;
    const details = d?.rcDetails as Record<string, unknown> | undefined;
    return (details?.chassisNumber as string) || null;
  });
  const [verificationId, setVerificationId] = useState(existingVerification?.id || "");
  const [error, setError] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [showMoreDocsModal, setShowMoreDocsModal] = useState(false);

  const handleVerify = async () => {
    if (!rcNumber.trim()) { setError("RC number is required"); return; }

    // Validate RC format client-side
    const cleaned = rcNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const rcPattern = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;
    if (!rcPattern.test(cleaned) || cleaned.length < 6 || cleaned.length > 13) {
      setError(`Invalid RC number "${rcNumber}". Expected format: MH12AB1234 (state code + district + series + number)`);
      return;
    }

    setStatus("loading");
    setError("");
    setChassisNumber(null);

    try {
      const res = await fetch(`${apiBase}/rc/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rc_number: rcNumber.trim().toUpperCase() }),
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        setError(`API returned ${res.status}. Please restart dev server.`);
        setStatus("failed");
        return;
      }
      const data = await res.json();

      if (data.success) {
        setChassisNumber(data.data?.rcDetails?.chassisNumber || null);
        if (data.data?.verificationId) setVerificationId(data.data.verificationId);
        setStatus("success");
      } else {
        setError(data.error?.message || "RC verification failed");
        setStatus("failed");
      }
    } catch {
      setError("Network error. Please try again.");
      setStatus("failed");
    }
  };

  const handleAdminAction = async (action: "accept" | "reject" | "request_more_docs") => {
    const vid = verificationId || existingVerification?.id;
    if (!vid) { setError("No verification record found. Please run verification first."); return; }
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

  const statusConfig: Record<CardStatus, { bg: string; label: string }> = {
    pending: { bg: "bg-gray-100 text-gray-600", label: "Pending" },
    loading: { bg: "bg-blue-100 text-blue-700", label: "Verifying..." },
    success: { bg: "bg-green-100 text-green-700", label: "Verified" },
    failed: { bg: "bg-red-100 text-red-700", label: "Failed" },
  };

  const hasResults = chassisNumber !== null && status !== "loading";

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-orange-600 flex items-center justify-center text-white font-bold text-sm">R</div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">RC to Chassis (Vehicle)</h3>
            <p className="text-xs text-gray-500">via Decentro</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusConfig[status].bg}`}>
          {statusConfig[status].label}
        </span>
      </div>

      <div className="p-5 space-y-5">
        {/* INPUT DATA */}
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide">Input Data</p>
            <OcrAutofillButton
              leadId={leadId}
              docType="rc_copy"
              cachedOcrData={ocrData}
              disabled={status === "loading"}
              onOcrResult={(data) => {
                const rc = (data.rc_number || data.rcNumber || data.registration_number || data.registrationNumber) as string | undefined;
                if (rc) setRcNumber(rc.toUpperCase());
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400 shrink-0">RC Number:</span>
            {editing ? (
              <input
                type="text"
                value={rcNumber}
                onChange={(e) => setRcNumber(e.target.value.toUpperCase())}
                onBlur={() => setEditing(false)}
                onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
                autoFocus
                className="flex-1 border border-orange-300 rounded-lg px-3 py-1.5 text-sm uppercase font-mono focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
              />
            ) : (
              <span className="font-medium text-gray-800 font-mono text-sm">
                {rcNumber || "Not available"}
              </span>
            )}
            {!editing && (status === "pending" || status === "failed") && (
              <button onClick={() => setEditing(true)}
                className="text-xs text-orange-600 hover:text-orange-700 font-medium">
                Edit
              </button>
            )}
          </div>
        </div>

        {/* Initiate Verification */}
        {(status === "pending" || status === "failed") && !hasResults && (
          <button onClick={handleVerify} disabled={!rcNumber.trim()}
            className="w-full bg-orange-600 hover:bg-orange-700 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
            Initiate Verification
          </button>
        )}

        {/* Loading */}
        {status === "loading" && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600" />
            <span className="ml-3 text-sm text-gray-600">Verifying RC...</span>
          </div>
        )}

        {/* RESULTS TABLE */}
        {hasResults && (
          <div>
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">RC Number</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Chassis Number</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="px-4 py-3 font-mono text-gray-800">{rcNumber}</td>
                    <td className="px-4 py-3 font-mono font-medium text-gray-800">{chassisNumber || "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Retry */}
        {status === "failed" && !hasResults && (
          <button onClick={() => { setStatus("pending"); setError(""); }}
            className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg text-sm font-medium transition-colors">
            Retry Verification
          </button>
        )}

        {/* ADMIN NOTES + DECISION */}
        {(status === "success" || status === "failed") && (verificationId || existingVerification?.id) && (
          <div className="space-y-3 pt-3 border-t border-gray-100">
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Admin Notes</p>
              <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                placeholder="RC verification remarks..."
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-orange-500 focus:border-orange-500" />
            </div>
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
                <button onClick={() => setShowMoreDocsModal(true)} disabled={!!actionLoading}
                  className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                  Request More Docs
                </button>
              </div>
            </div>
          </div>
        )}

        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{error}</div>}
      </div>

      <RequestMoreDocsModal
        open={showMoreDocsModal}
        onClose={() => setShowMoreDocsModal(false)}
        leadId={leadId}
        sourceVerificationId={verificationId || existingVerification?.id || null}
        sourceCardLabel="RC Verification"
        onSuccess={() => onActionComplete?.()}
      />
    </div>
  );
}
