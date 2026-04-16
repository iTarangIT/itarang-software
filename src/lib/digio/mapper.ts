/**
 * Build the payload for Digio's uploadpdf API
 * POST /v2/client/document/uploadpdf
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
  sign_coordinates_list?: DigioSignCoordinates[];
};

export type DigioUploadPdfInput = {
  fileData: string; // base64
  fileName: string;
  signers: DigioSigner[];
  expireInDays?: number;
  sequential?: boolean;
  templateId?: string;
};

const DEFAULT_CONSENT_SIGN_COORDINATES: DigioSignCoordinates = {
  page_no: 1,
  x: 380,
  y: 780,
  w: 180,
  h: 50,
};

const DEFAULT_CONSENT_SIGN_COORDINATES_PAGE2: DigioSignCoordinates = {
  page_no: 2,
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

/**
 * Payload for uploading a PDF for e-signing (consent flow)
 */
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
    signers: data.signers.map((signer) => {
      const coords = signer.sign_coordinates_list
        || (signer.sign_coordinates
          ? [signer.sign_coordinates]
          : [DEFAULT_CONSENT_SIGN_COORDINATES, DEFAULT_CONSENT_SIGN_COORDINATES_PAGE2]);
      // DigiO supports sign_coordinates (single) or multiple via first entry;
      // pass the first as sign_coordinates and rest as additional_sign_coordinates
      const { sign_coordinates_list: _list, ...rest } = signer;
      return {
        ...rest,
        sign_coordinates: coords[0],
        ...(coords.length > 1 ? { additional_sign_coordinates: coords.slice(1) } : {}),
      };
    }),
  };
}

/**
 * Payload for template-based dealer agreement (dealer onboarding flow)
 */
export function buildDigioPayload(data: any) {
  return {
    template_id: process.env.DIGIO_TEMPLATE_ID,
    signers: [
      { name: data.dealer.name, email: data.dealer.email, mobile: data.dealer.mobile, sequence: 1 },
      { name: data.financier.name, email: data.financier.email, mobile: data.financier.mobile, sequence: 2 },
      { name: data.itarang1.name, email: data.itarang1.email, mobile: data.itarang1.mobile, sequence: 3 },
      { name: data.itarang2.name, email: data.itarang2.email, mobile: data.itarang2.mobile, sequence: 4 },
    ],
    variables: {
      company_name: data.companyName,
      gst_number: data.gst,
      company_address: data.address,
      dealer_signatory_name: data.dealer.name,
      financier_name: data.financier.name,
      witness1_name: data.witness1.name,
      witness2_name: data.witness2.name,
    },
  };
}
