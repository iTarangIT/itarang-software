/**
 * Build the payload for Digio's uploadpdf API
 * POST /v2/client/document/uploadpdf
 *
 * @param data.fileData   - base64-encoded PDF content
 * @param data.fileName   - name of the PDF file
 * @param data.signers    - array of { identifier, name, reason, sign_type }
 * @param data.expireInDays - optional, defaults to 5
 * @param data.sequential - optional, defaults to true
 */
export type DigioSigner = {
  identifier: string; // email or 10-digit mobile
  name: string;
  reason: string;
  sign_type: "aadhaar" | "electronic" | "dsc";
};

export type DigioUploadPdfInput = {
  fileData: string; // base64
  fileName: string;
  signers: DigioSigner[];
  expireInDays?: number;
  sequential?: boolean;
};

export function buildUploadPdfPayload(data: DigioUploadPdfInput) {
  return {
    file_name: data.fileName,
    file_data: data.fileData,
    expire_in_days: data.expireInDays ?? 5,
    notify_signers: true,
    send_sign_link: true,
    include_authentication_url: true,
    sequential: data.sequential ?? true,
    signers: data.signers,
  };
}
