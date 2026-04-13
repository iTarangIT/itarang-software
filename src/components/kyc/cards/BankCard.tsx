"use client";

import { useState } from "react";
import OcrAutofillButton from "./OcrAutofillButton";

interface BankCardProps {
  leadId: string;
  leadName: string;
  accountNumber?: string;
  ifsc?: string;
  bankName?: string;
  branch?: string;
  ocrData?: Record<string, unknown> | null;
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
  existingVerification,
  onActionComplete,
}: BankCardProps) {
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
  const [result, setResult] = useState<Record<string, unknown> | null>(
    existingVerification?.apiResponse || null,
  );
  const [verificationId, setVerificationId] = useState(existingVerification?.id || "");
  const [error, setError] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");

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
      const res = await fetch(`/api/kyc/${leadId}/decentro/bank`, {
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
    const vid = verificationId || existingVerification?.id;
    if (!vid) { setError("No verification record found. Please run verification first."); return; }
    if (action === "reject" && !adminNotes.trim()) {
      setError("Please add rejection reason");
      return;
    }
    setActionLoading(action);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/kyc/${leadId}/verification/${vid}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            notes: adminNotes,
            rejection_reason: action === "reject" ? adminNotes : undefined,
          }),
        },
      );
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
                          bankData.bankTxnId ||
                          "—") as string
                      }
                    </td>
                  </tr>
                  {bankData.validation_message && (
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

        {/* Admin Actions */}
        {(status === "success" || status === "failed") &&
          (verificationId || existingVerification?.id) && (
            <div className="space-y-3 pt-3 border-t border-gray-100">
              <div>
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  Admin Notes
                </label>
                <textarea
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  rows={2}
                  placeholder="Verification remarks..."
                  className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleAdminAction("accept")}
                  disabled={!!actionLoading}
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {actionLoading === "accept" ? "..." : "Accept"}
                </button>
                <button
                  onClick={() => handleAdminAction("reject")}
                  disabled={!!actionLoading}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {actionLoading === "reject" ? "..." : "Reject"}
                </button>
                <button
                  onClick={() => handleAdminAction("request_more_docs")}
                  disabled={!!actionLoading}
                  className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {actionLoading === "request_more_docs"
                    ? "..."
                    : "Request Docs"}
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
    </div>
  );
}
