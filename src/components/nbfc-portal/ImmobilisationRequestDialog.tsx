"use client";

/**
 * E-033 — ImmobilisationRequestDialog
 *
 * Risk Head's "Request Immobilisation" entry point. Wraps the mandatory
 * BorrowerNoticePreview (BRD §6.1.6) and submits to
 * POST /api/nbfc/actions/immobilisation/request once the operator has
 * confirmed the notice.
 */
import { useState } from "react";
import {
  BorrowerNoticePreview,
  type BorrowerNoticeContent,
} from "@/components/nbfc-portal/BorrowerNoticePreview";

interface Props {
  loanSanctionId: string;
  notice: BorrowerNoticeContent;
  open: boolean;
  onClose: () => void;
  onRequested?: (result: {
    action_id: string;
    status: string;
    created_at: string;
  }) => void;
}

export function ImmobilisationRequestDialog({
  loanSanctionId,
  notice,
  open,
  onClose,
  onRequested,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit(compiledNoticeText: string) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/actions/immobilisation/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loan_sanction_id: loanSanctionId,
          notice_confirmed: true,
          notice_text: compiledNoticeText,
          outstanding_amount: notice.outstanding_amount,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      onRequested?.(body);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="immobilisation-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-xl rounded-lg bg-white p-5 shadow-xl">
        <h2
          id="immobilisation-dialog-title"
          className="mb-3 text-lg font-semibold"
        >
          Request Immobilisation
        </h2>
        <p className="mb-3 text-sm text-gray-700">
          Loan: <code>{loanSanctionId}</code>. This request will be sent to
          Ops for second approval. Reversible after EMI settlement.
        </p>

        <BorrowerNoticePreview
          notice={notice}
          onConfirmedSubmit={submit}
          submitting={submitting}
        />

        {error && (
          <p
            data-testid="immobilisation-error"
            className="mt-3 text-sm text-red-700"
          >
            Error: {error}
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default ImmobilisationRequestDialog;
