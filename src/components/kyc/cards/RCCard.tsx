"use client";

import { useState } from "react";

interface RCCardProps {
  leadId: string;
  rcNumber?: string;
  existingVerification?: {
    id: string;
    status: string;
    adminAction?: string | null;
    adminActionNotes?: string | null;
  } | null;
  onActionComplete?: () => void;
}

interface RcDetails {
  chassisNumber: string | null;
  engineNumber: string | null;
  ownerName: string | null;
  registrationDate: string | null;
  vehicleClass: string | null;
  fuelType: string | null;
  makerModel: string | null;
  fitnessUpto: string | null;
  insuranceUpto: string | null;
}

type CardStatus = "pending" | "loading" | "success" | "failed";

export default function RCCard({
  leadId,
  rcNumber: initRc = "",
  existingVerification,
  onActionComplete,
}: RCCardProps) {
  const [rcNumber, setRcNumber] = useState(initRc);
  const [status, setStatus] = useState<CardStatus>(() => {
    if (existingVerification?.adminAction === "accepted") return "success";
    if (existingVerification?.adminAction === "rejected") return "failed";
    if (existingVerification?.status === "success") return "success";
    if (existingVerification?.status === "failed") return "failed";
    return "pending";
  });
  const [rcDetails, setRcDetails] = useState<RcDetails | null>(null);
  const [error, setError] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");

  const handleVerify = async () => {
    if (!rcNumber.trim()) { setError("RC number is required"); return; }
    setStatus("loading");
    setError("");
    setRcDetails(null);

    try {
      const res = await fetch(`/api/admin/kyc/${leadId}/rc/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rc_number: rcNumber.trim().toUpperCase() }),
      });
      const data = await res.json();

      if (data.success) {
        setRcDetails(data.data.rcDetails);
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

  const statusConfig: Record<CardStatus, { bg: string; label: string }> = {
    pending: { bg: "bg-gray-100 text-gray-600", label: "Pending" },
    loading: { bg: "bg-blue-100 text-blue-700", label: "Verifying..." },
    success: { bg: "bg-green-100 text-green-700", label: "Verified" },
    failed: { bg: "bg-red-100 text-red-700", label: "Failed" },
  };

  const detailRows = rcDetails ? [
    { label: "Chassis Number", value: rcDetails.chassisNumber },
    { label: "Engine Number", value: rcDetails.engineNumber },
    { label: "Owner Name", value: rcDetails.ownerName },
    { label: "Registration Date", value: rcDetails.registrationDate },
    { label: "Vehicle Class", value: rcDetails.vehicleClass },
    { label: "Fuel Type", value: rcDetails.fuelType },
    { label: "Make / Model", value: rcDetails.makerModel },
    { label: "Fitness Upto", value: rcDetails.fitnessUpto },
    { label: "Insurance Upto", value: rcDetails.insuranceUpto },
  ] : [];

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-orange-600 flex items-center justify-center text-white font-bold text-sm">R</div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">RC / Chassis Verification</h3>
            <p className="text-xs text-gray-500">via Decentro</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusConfig[status].bg}`}>
          {statusConfig[status].label}
        </span>
      </div>

      <div className="p-5 space-y-5">
        {/* Input */}
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Input Data</p>
          <div>
            <label className="text-xs text-gray-500">RC Number</label>
            <input type="text" value={rcNumber}
              onChange={(e) => setRcNumber(e.target.value.toUpperCase())}
              placeholder="e.g. DL3CAB7889" disabled={status === "loading"}
              className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm uppercase focus:ring-2 focus:ring-orange-500 focus:border-orange-500 disabled:bg-gray-100" />
          </div>
        </div>

        {status === "pending" && (
          <button onClick={handleVerify}
            className="w-full bg-orange-600 hover:bg-orange-700 text-white py-2.5 rounded-lg text-sm font-medium transition-colors">
            Verify RC Number
          </button>
        )}

        {status === "loading" && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600" />
            <span className="ml-3 text-sm text-gray-600">Verifying RC...</span>
          </div>
        )}

        {/* RC Details */}
        {rcDetails && (
          <div>
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Vehicle Details</p>
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {detailRows.map((row) => (
                    <tr key={row.label} className="hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 text-gray-600 w-1/3">{row.label}</td>
                      <td className="px-4 py-2.5 font-medium text-gray-800">{row.value || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Admin Actions */}
        {(status === "success" || status === "failed") && existingVerification?.id && (
          <div className="space-y-3 pt-3 border-t border-gray-100">
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Admin Notes</label>
              <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                placeholder="RC verification remarks..."
                className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-orange-500 focus:border-orange-500" />
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

        {/* Retry on failure */}
        {status === "failed" && !rcDetails && (
          <button onClick={() => { setStatus("pending"); setError(""); }}
            className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg text-sm font-medium transition-colors">
            Retry Verification
          </button>
        )}

        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{error}</div>}
      </div>
    </div>
  );
}
