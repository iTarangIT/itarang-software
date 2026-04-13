"use client";

import { useEffect, useState } from "react";

// BRD §2.9.3 "Request Co-Borrower KYC Form" — opened from the CIBIL card's
// [Need Co-Borrower KYC] button or from the primary final-decision panel.
// Admin enters a reason (visible to the dealer) and on submit a coBorrowers
// stub + co_borrower_requests row are created and the lead flips into the
// awaiting_co_borrower_kyc / awaiting_co_borrower_replacement state.

interface RequestCoBorrowerModalProps {
  open: boolean;
  onClose: () => void;
  leadId: string;
  isReplacement?: boolean;
  onSuccess?: () => void;
}

export default function RequestCoBorrowerModal({
  open,
  onClose,
  leadId,
  isReplacement = false,
  onSuccess,
}: RequestCoBorrowerModalProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setReason("");
      setError("");
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!reason.trim()) {
      setError("Please explain why a co-borrower is required.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/kyc/${leadId}/step3/request-coborrower`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: reason.trim(),
            is_replacement: isReplacement,
          }),
        },
      );
      const data = await res.json();
      if (!data.success) {
        setError(data.error?.message ?? "Request failed");
        setSubmitting(false);
        return;
      }
      onSuccess?.();
      onClose();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">
            {isReplacement
              ? "Request Replacement Co-Borrower"
              : "Request Co-Borrower KYC"}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-600">
            {isReplacement
              ? "The current co-borrower will be archived. The dealer will be asked to submit fresh co-borrower details."
              : "The dealer's interim KYC step will unlock. They will fill the co-borrower form, upload 11 documents and send consent to the co-borrower."}
          </p>

          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Reason (visible to dealer)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder={
                isReplacement
                  ? "e.g. Previous co-borrower's CIBIL is 590 (below 700 threshold)"
                  : "e.g. Primary applicant's CIBIL is 610, high DTI ratio"
              }
              className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            />
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
            Co-borrower must meet the full KYC criteria (Aadhaar, PAN, Bank,
            CIBIL ≥ 700, Address, RC). The dealer will also need to validate a
            coupon before submitting.
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2 bg-gray-50">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            {submitting ? "Sending request…" : "Send Request"}
          </button>
        </div>
      </div>
    </div>
  );
}
