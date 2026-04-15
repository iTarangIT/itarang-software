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
export type DigioSignCoordinates = {
  page_no: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
};

export type DigioSigner = {
  identifier: string; // email or 10-digit mobile
  name: string;
  reason: string;
  sign_type: "aadhaar" | "electronic" | "dsc";
  sign_coordinates?: DigioSignCoordinates;
};

export type DigioUploadPdfInput = {
  fileData: string; // base64
  fileName: string;
  signers: DigioSigner[];
  expireInDays?: number;
  sequential?: boolean;
  templateId?: string;
};

/**
 * Default sign coordinates: bottom-right of page 1
 * A4 in points: 595 x 842. Places the eSign stamp at the signature area.
 */
const DEFAULT_CONSENT_SIGN_COORDINATES: DigioSignCoordinates = {
  page_no: 1,
  x: 380,
  y: 780,
  w: 180,
  h: 50,
};

function getWebhookUrl(): string {
  const base =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";
  return `${base}/api/webhooks/digio`;
}

export function buildUploadPdfPayload(data: DigioUploadPdfInput) {
  return {
    file_name: data.fileName,
    file_data: data.fileData,
    expire_in_days: data.expireInDays ?? 5,
    notify_signers: true,
    send_sign_link: true,
    include_authentication_url: true,
    sequential: data.sequential ?? true,
    notify_url: getWebhookUrl(),
    ...(data.templateId ? { template_id: data.templateId } : {}),
    signers: data.signers.map((signer) => ({
      ...signer,
      sign_coordinates: signer.sign_coordinates || DEFAULT_CONSENT_SIGN_COORDINATES,
    })),
  };
}
