"use client";

import { useEffect, useState } from "react";

// BRD §2.9.3 "Request Additional Documents Form" — opened from any primary
// KYC verification card's [Request More Docs] button, or from the supporting-
// docs panel's per-card [Request Docs] action.
//
// The form lets admin queue one-or-more document requests in a single action.
// Each row carries its own doc label + reason (visible to the dealer). On
// submit we POST the full list to the step3/request-docs route which creates
// one otherDocumentRequests row per item and flips the lead into a Step 3
// waiting state.

type DocItem = {
  doc_label: string;
  is_required: boolean;
  reason: string;
};

const PRESET_DOC_LABELS = [
  "Aadhaar Front",
  "Aadhaar Back",
  "PAN Card",
  "Passport Size Photo",
  "Bank Statement (3 months)",
  "Address Proof",
  "Cancelled Cheque",
  "RC Copy",
  "Salary Slips (3 months)",
  "ITR",
  "Business Proof",
  "Other (custom)",
];

interface RequestMoreDocsModalProps {
  open: boolean;
  onClose: () => void;
  leadId: string;
  sourceVerificationId?: string | null;
  sourceCardLabel?: string; // e.g. "PAN Verification"
  defaultDocFor?: "primary" | "co_borrower";
  onSuccess?: () => void;
}

export default function RequestMoreDocsModal({
  open,
  onClose,
  leadId,
  sourceVerificationId,
  sourceCardLabel,
  defaultDocFor = "primary",
  onSuccess,
}: RequestMoreDocsModalProps) {
  const [docFor, setDocFor] = useState<"primary" | "co_borrower">(
    defaultDocFor,
  );
  const [items, setItems] = useState<DocItem[]>([
    { doc_label: "", is_required: true, reason: "" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setDocFor(defaultDocFor);
      setItems([{ doc_label: "", is_required: true, reason: "" }]);
      setError("");
    }
  }, [open, defaultDocFor]);

  if (!open) return null;

  const updateItem = (index: number, patch: Partial<DocItem>) => {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { doc_label: "", is_required: true, reason: "" },
    ]);
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const cleaned = items
      .map((i) => ({
        doc_label: i.doc_label.trim(),
        is_required: i.is_required,
        reason: i.reason.trim(),
      }))
      .filter((i) => i.doc_label.length > 0);

    if (cleaned.length === 0) {
      setError("Add at least one document to request.");
      return;
    }
    if (cleaned.some((i) => !i.reason)) {
      setError("Each document needs a reason for the dealer.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/kyc/${leadId}/step3/request-docs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: cleaned,
            doc_for: docFor,
            source_verification_id: sourceVerificationId ?? undefined,
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
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Request Additional Documents
            </h2>
            {sourceCardLabel && (
              <p className="text-xs text-gray-500 mt-0.5">
                From: {sourceCardLabel}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Request For
            </label>
            <div className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  checked={docFor === "primary"}
                  onChange={() => setDocFor("primary")}
                />
                Primary Applicant
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  checked={docFor === "co_borrower"}
                  onChange={() => setDocFor("co_borrower")}
                />
                Co-Borrower
              </label>
            </div>
          </div>

          <div className="space-y-4">
            {items.map((item, i) => (
              <div
                key={i}
                className="border border-gray-200 rounded-lg p-4 bg-gray-50/50"
              >
                <div className="flex items-start justify-between mb-3">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Document #{i + 1}
                  </span>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItem(i)}
                      className="text-xs text-red-600 hover:text-red-700 font-medium"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-gray-500">
                      Document Label
                    </label>
                    <select
                      value={
                        PRESET_DOC_LABELS.includes(item.doc_label)
                          ? item.doc_label
                          : "Other (custom)"
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        updateItem(i, {
                          doc_label: v === "Other (custom)" ? "" : v,
                        });
                      }}
                      className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="">Select document…</option>
                      {PRESET_DOC_LABELS.map((label) => (
                        <option key={label} value={label}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {(!PRESET_DOC_LABELS.includes(item.doc_label) ||
                      item.doc_label === "") && (
                      <input
                        type="text"
                        value={item.doc_label}
                        onChange={(e) =>
                          updateItem(i, { doc_label: e.target.value })
                        }
                        placeholder="Custom document label"
                        className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    )}
                  </div>

                  <div>
                    <label className="text-xs text-gray-500">
                      Reason (shown to dealer)
                    </label>
                    <textarea
                      value={item.reason}
                      onChange={(e) =>
                        updateItem(i, { reason: e.target.value })
                      }
                      rows={2}
                      placeholder="e.g. Pincode on address proof is not readable"
                      className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                    />
                  </div>

                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={item.is_required}
                      onChange={(e) =>
                        updateItem(i, { is_required: e.target.checked })
                      }
                    />
                    Required
                  </label>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={addItem}
              className="w-full border-2 border-dashed border-gray-300 rounded-lg py-3 text-sm text-gray-600 hover:border-teal-500 hover:text-teal-600 transition-colors"
            >
              + Add another document
            </button>
          </div>

          <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-500">
            Notifications to the dealer (SMS / WhatsApp / Email) are sent from
            the dealer portal after the request is created.
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
