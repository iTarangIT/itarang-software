"use client";

import { useState } from "react";

interface ManualDecisionSectionProps {
  leadId: string;
  verificationType:
    | "aadhaar"
    | "pan"
    | "bank"
    | "rc"
    | "cibil"
    | "address"
    | "mobile"
    | "photo";
  applicant?: "primary" | "co_borrower";
  onActionComplete?: () => void;
}

export default function ManualDecisionSection({
  leadId,
  verificationType,
  applicant = "primary",
  onActionComplete,
}: ManualDecisionSectionProps) {
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState<"accept" | "reject" | "">("");
  const [error, setError] = useState("");

  const submit = async (action: "accept" | "reject") => {
    if (action === "reject" && !notes.trim()) {
      setError("Please add rejection reason in notes");
      return;
    }
    setLoading(action);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/kyc/${leadId}/verification/manual`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            verification_type: verificationType,
            applicant,
            notes,
            rejection_reason: action === "reject" ? notes : undefined,
          }),
        },
      );
      const data = await res.json();
      if (data.success) {
        onActionComplete?.();
      } else {
        setError(data.error?.message || "Action failed");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading("");
    }
  };

  return (
    <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/60 p-4 space-y-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          Manual Override
        </p>
        <p className="text-[11px] text-amber-700/80 mt-0.5">
          Decide without running the API check — used when verification is not
          possible or already confirmed offline.
        </p>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        placeholder="Remarks (required when rejecting)..."
        className="w-full text-sm border border-amber-200 bg-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
      />
      <div className="flex gap-2">
        <button
          onClick={() => submit("accept")}
          disabled={!!loading}
          className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {loading === "accept" ? "..." : "Manual Accept"}
        </button>
        <button
          onClick={() => submit("reject")}
          disabled={!!loading}
          className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {loading === "reject" ? "..." : "Manual Reject"}
        </button>
      </div>
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
