"use client";

import { useState } from "react";
import OcrAutofillButton from "./OcrAutofillButton";
import RequestMoreDocsModal from "../step3/RequestMoreDocsModal";

interface BankCardProps {
  leadId: string;
  leadName: string;
  accountNumber?: string;
  ifsc?: string;
  bankName?: string;
  branch?: string;
  ocrData?: Record<string, unknown> | null;
  applicant?: "primary" | "co_borrower";
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

type CardStatus = "pending" | "loading" | "success" | "failed";
type ValidationType = "penniless" | "pennydrop" | "pennydrop_name_match";

export default function BankCard({
  leadId,
  leadName,
  accountNumber: initAccNo = "",
  ifsc: initIfsc = "",
  bankName: initBank = "",
  branch: initBranch = "",
  ocrData,
  applicant = "primary",
  existingVerification,
  onActionComplete,
}: BankCardProps) {
  const apiBase =
    applicant === "co_borrower"
      ? `/api/admin/kyc/${leadId}/coborrower`
      : `/api/admin/kyc/${leadId}`;
  const [accountNumber, setAccountNumber] = useState(initAccNo);
  const [ifsc, setIfsc] = useState(initIfsc);
  const [bankName, setBankName] = useState(initBank);
  const [branch, setBranch] = useState(initBranch);
  const [validationType, setValidationType] =
    useState<ValidationType>("penniless");
  const [status, setStatus] = useState<CardStatus>(() => {
    if (existingVerification?.adminAction === "accepted") return "success";
    if (existingVerification?.adminAction === "rejected") return "failed";
    if (existingVerification?.status === "success") return "success";
    if (existingVerification?.status === "failed") return "failed";
    return "pending";
  });
  // DB stores the raw flat Decentro v2 response under api_response. The fresh-verify
  // path wraps it as { success, message, data: {...} }. Normalize the DB shape to match
  // so the results table renders identically on reload.
  const [result, setResult] = useState<Record<string, unknown> | null>(() => {
    const saved = existingVerification?.apiResponse;
    if (!saved) return null;
    const nested = (saved as Record<string, unknown>).data as Record<string, unknown> | undefined;
    return {
      message: (saved as Record<string, unknown>).message,
      data: nested ? { ...saved, ...nested } : { ...saved },
    };
  });
  const [verificationId, setVerificationId] = useState(existingVerification?.id || "");
  const [error, setError] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [showMoreDocsModal, setShowMoreDocsModal] = useState(false);
  const [actionResult, setActionResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleVerify = async () => {
    if (!accountNumber.trim()) {
      setError("Account number is required");
      return;
    }
    if (!ifsc.trim()) {
      setError("IFSC code is required");
      return;
    }
    setStatus("loading");
    setError("");
    setResult(null);

    try {
      const res = await fetch(`${apiBase}/bank/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_number: accountNumber.trim(),
          ifsc: ifsc.trim().toUpperCase(),
          name: leadName,
          perform_name_match: validationType === "pennydrop_name_match",
          validation_type:
            validationType === "pennydrop_name_match"
              ? "pennydrop"
              : validationType,
        }),
      });
      const data = await res.json();
      setResult(data);
      if (data.data?.verificationId) setVerificationId(data.data.verificationId);
      setStatus(data.success ? "success" : "failed");
      if (!data.success)
        setError(data.message || data.error || "Bank verification failed");
    } catch {
      setStatus("failed");
      setError("Network error. Please try again.");
    }
  };

  const handleAdminAction = async (
    action: "accept" | "reject" | "request_more_docs",
  ) => {
    if (action === "request_more_docs") { setShowMoreDocsModal(true); return; }
    if (action === "reject" && !adminNotes.trim()) {
      setError("Please add rejection reason");
      return;
    }
    setActionLoading(action);
    setError("");
    setActionResult(null);
    try {
      const vid = verificationId || existingVerification?.id;
      const res = vid
        ? await fetch(`/api/admin/kyc/${leadId}/verification/${vid}/action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, notes: adminNotes, rejection_reason: action === "reject" ? adminNotes : undefined }),
          })
        : await fetch(`/api/admin/kyc/${leadId}/verification/manual`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, verification_type: "bank", applicant, notes: adminNotes, rejection_reason: action === "reject" ? adminNotes : undefined }),
          });
      const data = await res.json();
      if (data.success) {
        if (action === "accept") {
          setStatus("success");
          setActionResult({ success: true, message: "Bank verification accepted successfully" });
        } else if (action === "reject") {
          setStatus("failed");
          setActionResult({ success: true, message: "Bank verification rejected" });
        }
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

  const validationOptions: {
    value: ValidationType;
    label: string;
    cost: string;
  }[] = [
    { value: "penniless", label: "Penniless", cost: "~Rs.1.50" },
    { value: "pennydrop", label: "Pennydrop", cost: "~Rs.1.50 + Rs.1" },
    {
      value: "pennydrop_name_match",
      label: "Pennydrop + Name Match",
      cost: "~Rs.1.50 + Rs.1",
    },
  ];

  const bankData = result?.data as Record<string, unknown> | undefined;

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-bold text-sm">
            B
          </div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">
              Bank Account Verification
            </h3>
            <p className="text-xs text-gray-500">via Decentro</p>
          </div>
        </div>
        <span
          className={`px-3 py-1 rounded-full text-xs font-semibold ${statusConfig[status].bg}`}
        >
          {statusConfig[status].label}
        </span>
      </div>

      <div className="p-5 space-y-5">
        {/* Input Fields */}
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide">
              Input Data
            </p>
            <OcrAutofillButton
              leadId={leadId}
              docType={["bank_statement", "cheque_1", "cheque_2", "cheque_3", "cheque_4"]}
              cachedOcrData={ocrData}
              disabled={status === "loading"}
              onOcrResult={(data) => {
                const acct = (data.account_number || data.accountNumber) as string | undefined;
                const ifc = (data.ifsc || data.ifsc_code || data.ifscCode) as string | undefined;
                const bank = (data.bank_name || data.bankName) as string | undefined;
                const br = (data.branch || data.branchName) as string | undefined;
                if (acct) setAccountNumber(acct);
                if (ifc) setIfsc(ifc.toUpperCase());
                if (bank) setBankName(bank);
                if (br) setBranch(br);
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500">Account Number</label>
              <input
                type="text"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                placeholder="Enter account number"
                disabled={status === "loading"}
                className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">IFSC Code</label>
              <input
                type="text"
                value={ifsc}
                onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                placeholder="e.g. SBIN0001234"
                disabled={status === "loading"}
                className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm uppercase focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Bank Name</label>
              <input
                type="text"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="Bank name"
                disabled={status === "loading"}
                className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Branch</label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="Branch name"
                disabled={status === "loading"}
                className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">
                Account Holder (Lead)
              </label>
              <input
                type="text"
                value={leadName}
                disabled
                className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-500"
              />
            </div>
          </div>
        </div>

        {/* Verification Method Selection */}
        <div>
          <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-2">
            Verification Method
          </p>
          <div className="grid grid-cols-3 gap-2">
            {validationOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setValidationType(opt.value)}
                className={`p-3 rounded-lg border text-left transition-all ${
                  validationType === opt.value
                    ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <p className="text-sm font-medium text-gray-800">{opt.label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{opt.cost}</p>
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleVerify}
          disabled={status === "loading"}
          className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {status === "loading" ? "Verifying..." : "Run Bank Verification"}
        </button>


        {/* Results */}
        {result && bankData && (
          <div>
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">
              Verification Results
            </p>
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">
                      Field
                    </th>
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="px-4 py-2 text-gray-600">Account Status</td>
                    <td className="px-4 py-2">
                      {(() => {
                        const status = String(
                          bankData.account_status ||
                            bankData.accountStatus ||
                            "—",
                        ).toLowerCase();
                        const isValid = status === "valid";
                        return (
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-medium ${
                              isValid
                                ? "bg-green-100 text-green-700"
                                : "bg-red-100 text-red-700"
                            }`}
                          >
                            {String(
                              bankData.account_status ||
                                bankData.accountStatus ||
                                "—",
                            )}
                          </span>
                        );
                      })()}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-gray-600">
                      Account Holder (Bank)
                    </td>
                    <td className="px-4 py-2 font-medium text-gray-800">
                      {
                        (bankData.beneficiary_name ||
                          bankData.beneficiaryName ||
                          bankData.accountHolderName ||
                          "—") as string
                      }
                    </td>
                  </tr>
                  {(bankData.name_match_percentage !== undefined ||
                    bankData.nameMatchScore !== undefined) && (
                    <tr>
                      <td className="px-4 py-2 text-gray-600">Name Match</td>
                      <td className="px-4 py-2">
                        {(() => {
                          const score = Number(
                            bankData.name_match_percentage ??
                              bankData.nameMatchScore ??
                              0,
                          );
                          return (
                            <span
                              className={`text-xs font-medium ${score >= 80 ? "text-green-700" : "text-red-700"}`}
                            >
                              {score}%
                            </span>
                          );
                        })()}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td className="px-4 py-2 text-gray-600">Bank Reference</td>
                    <td className="px-4 py-2 text-gray-800 font-mono text-xs">
                      {
                        (bankData.bank_reference_number ||
                          bankData.bankReferenceNumber ||
                          bankData.bankTxnId ||
                          "—") as string
                      }
                    </td>
                  </tr>
                  {Boolean(bankData.validation_message) && (
                    <tr>
                      <td className="px-4 py-2 text-gray-600">Validation</td>
                      <td className="px-4 py-2 text-gray-600 text-xs">
                        {String(bankData.validation_message)}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td className="px-4 py-2 text-gray-600">Message</td>
                    <td className="px-4 py-2 text-gray-600 text-xs">
                      {(result.message || "—") as string}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Admin Actions — Always visible */}
        {status !== "loading" && (
          <div className="space-y-3 pt-4 border-t border-gray-200">
            {(existingVerification?.adminAction || actionResult) && (
              <div className={`rounded-lg p-3 text-sm font-medium flex items-center gap-2 ${
                (existingVerification?.adminAction === "accepted" || actionResult?.success)
                  ? "bg-green-50 border border-green-200 text-green-700"
                  : "bg-red-50 border border-red-200 text-red-700"
              }`}>
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  {(existingVerification?.adminAction === "accepted" || (actionResult?.success && actionResult.message.includes("accepted")))
                    ? <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    : <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  }
                </svg>
                {actionResult?.message || `Bank verification ${existingVerification?.adminAction} by admin.`}
              </div>
            )}
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Admin Notes
              </label>
              <textarea
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                rows={2}
                placeholder="Verification remarks..."
                className="w-full mt-1.5 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleAdminAction("accept")}
                disabled={!!actionLoading}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors shadow-sm"
              >
                {actionLoading === "accept" ? "Accepting..." : "Accept"}
              </button>
              <button
                onClick={() => handleAdminAction("reject")}
                disabled={!!actionLoading}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors shadow-sm"
              >
                {actionLoading === "reject" ? "Rejecting..." : "Reject"}
              </button>
              <button
                onClick={() => handleAdminAction("request_more_docs")}
                disabled={!!actionLoading}
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors shadow-sm"
              >
                Request Docs
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
            {error}
          </div>
        )}
      </div>

      <RequestMoreDocsModal
        open={showMoreDocsModal}
        onClose={() => setShowMoreDocsModal(false)}
        leadId={leadId}
        sourceVerificationId={existingVerification?.id || null}
        sourceCardLabel="Bank Verification"
        onSuccess={() => onActionComplete?.()}
      />
    </div>
  );
}
