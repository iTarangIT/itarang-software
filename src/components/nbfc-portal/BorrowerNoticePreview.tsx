"use client";

/**
 * E-033 — BorrowerNoticePreview
 *
 * BRD §6.1.6 "Immobilisation — Borrower Notice Mandatory":
 * Before any immobilisation request can be submitted, the NBFC portal MUST
 * show a Borrower Notice Preview. The notice must include:
 *   1. Lender identity (NBFC legal name)
 *   2. LSP identity (iTarang Battery Solutions)
 *   3. Outstanding amount + restoration steps
 *   4. Grievance channel URL + helpline
 *   5. Plain, non-coercive language
 * Admin must check "I confirm the notice is accurate" before proceeding.
 * Per RBI Digital Lending Directions 2025.
 *
 * The submit button is disabled until the confirmation checkbox is checked.
 */
import { useState } from "react";

export interface BorrowerNoticeContent {
  lender_legal_name: string;
  outstanding_amount: number;
  restoration_steps: string;
  grievance_url: string;
  helpline: string;
}

interface Props {
  notice: BorrowerNoticeContent;
  onConfirmedSubmit?: (compiledNoticeText: string) => void;
  submitting?: boolean;
}

export const BORROWER_NOTICE_LSP = "iTarang Battery Solutions" as const;

export function compileNoticeText(notice: BorrowerNoticeContent): string {
  return [
    `Lender: ${notice.lender_legal_name} (NBFC).`,
    `Loan Service Provider (LSP): ${BORROWER_NOTICE_LSP}.`,
    `Outstanding amount: ₹${notice.outstanding_amount}. Restoration: ${notice.restoration_steps}.`,
    `Grievance channel: ${notice.grievance_url}. Helpline: ${notice.helpline}.`,
    `This notice is provided in plain, non-coercive language. We will work cooperatively to restore service after settlement.`,
  ].join("\n");
}

export function BorrowerNoticePreview({
  notice,
  onConfirmedSubmit,
  submitting = false,
}: Props) {
  const [confirmed, setConfirmed] = useState(false);

  const submitDisabled = !confirmed || submitting;
  const compiledText = compileNoticeText(notice);

  return (
    <section
      data-testid="borrower-notice-preview"
      aria-labelledby="borrower-notice-title"
      className="rounded-md border border-gray-200 bg-white p-4"
    >
      <h2
        id="borrower-notice-title"
        className="mb-3 text-base font-semibold"
      >
        Borrower Notice Preview
      </h2>

      <ol className="space-y-2 text-sm text-gray-800">
        <li data-testid="notice-lender-identity">
          <strong>Lender identity:</strong> {notice.lender_legal_name} (NBFC)
        </li>
        <li data-testid="notice-lsp-identity">
          <strong>LSP identity:</strong> {BORROWER_NOTICE_LSP}
        </li>
        <li data-testid="notice-outstanding">
          <strong>Outstanding amount:</strong> ₹{notice.outstanding_amount}
          <div className="text-xs text-gray-600">
            <strong>Restoration steps:</strong> {notice.restoration_steps}
          </div>
        </li>
        <li data-testid="notice-grievance">
          <strong>Grievance channel:</strong>{" "}
          <a className="text-blue-700 underline" href={notice.grievance_url}>
            {notice.grievance_url}
          </a>{" "}
          · <strong>Helpline:</strong> {notice.helpline}
        </li>
        <li data-testid="notice-plain-language">
          <strong>Language:</strong> Plain, non-coercive — cooperative tone,
          fair treatment per RBI Digital Lending Directions 2025.
        </li>
      </ol>

      <label
        data-testid="notice-confirm-checkbox-label"
        className="mt-4 flex items-center gap-2 text-sm"
      >
        <input
          data-testid="notice-confirm-checkbox"
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I confirm the notice is accurate
      </label>

      <button
        data-testid="notice-submit-button"
        type="button"
        disabled={submitDisabled}
        aria-disabled={submitDisabled}
        onClick={() => onConfirmedSubmit?.(compiledText)}
        className="mt-3 rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit Immobilisation Request"}
      </button>
    </section>
  );
}

export default BorrowerNoticePreview;
