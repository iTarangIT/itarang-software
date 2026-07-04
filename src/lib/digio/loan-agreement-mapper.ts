/**
 * Digio uploadpdf payload for the borrower LOAN AGREEMENT (BRD Addendum V0.3.1
 * §17 — "iTarang eSign"). The NBFC uploads the unsigned agreement PDF and the
 * customer + NBFC signatory sign it.
 *
 * This differs from the consent `buildUploadPdfPayload` in two ways that matter
 * for our flow:
 *   - `notify_url` points at the LOAN-AGREEMENT webhook (not the generic
 *     /api/webhooks/digio), so status callbacks reach the right handler.
 *   - a top-level `callback: "AGR_<ref>"` is added so the webhook can correlate
 *     the event to the nbfc_loan_agreements row (with digio_document_id as a
 *     fallback match).
 */
import type { DigioSignCoordinates, DigioSigner } from "./mapper";

export interface LoanAgreementUploadInput {
  fileData: string; // base64-encoded PDF
  fileName: string;
  agreementRef: string; // becomes the AGR_<ref> callback token
  signers: DigioSigner[]; // ordered; sequential signing (customer, then NBFC)
  expireInDays?: number;
}

function loanAgreementWebhookUrl(): string {
  const base =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";
  return `${base}/api/digio/webhook/loan-agreement`;
}

export function buildLoanAgreementUploadPayload(
  data: LoanAgreementUploadInput,
  opts?: { notifyUrl?: string },
) {
  return {
    file_name: data.fileName,
    file_data: data.fileData,
    expire_in_days: data.expireInDays ?? 14,
    notify_signers: true,
    // Direct tokenised signing link (otherwise Digio sends the generic
    // "Register and Login" invite, leaving the borrower unable to sign).
    send_sign_link: true,
    include_authentication_url: true,
    generate_access_token: true,
    sequential: true, // customer signs first, then the NBFC signatory (§17.3)
    // E-166 — a per-tenant Digio adapter overrides this to its own webhook route
    // (/api/esign/digio/webhook); global Digio keeps the default loan-agreement
    // webhook so in-flight docs are unaffected.
    notify_url: opts?.notifyUrl ?? loanAgreementWebhookUrl(),
    callback: `AGR_${data.agreementRef}`,
    signers: data.signers.map((signer) => {
      const coords: DigioSignCoordinates[] =
        signer.sign_coordinates_list ||
        (signer.sign_coordinates ? [signer.sign_coordinates] : []);
      const out: Record<string, unknown> = {
        identifier: signer.identifier,
        name: signer.name,
        reason: signer.reason,
        sign_type: signer.sign_type,
      };
      if (coords.length > 0) out.sign_coordinates = coords[0];
      if (coords.length > 1) out.additional_sign_coordinates = coords.slice(1);
      return out;
    }),
  };
}
