import { digioClient } from "./client";
import { buildUploadPdfPayload, type DigioUploadPdfInput } from "./mapper";

/**
 * Upload a PDF to Digio for e-signing via /v2/client/document/uploadpdf
 */
export async function createDigioAgreement(data: DigioUploadPdfInput) {
  const payload = buildUploadPdfPayload(data);
  const response = await digioClient.post("/v2/client/document/uploadpdf", payload);
  return response.data;
}

/**
 * Get document status from Digio via /v2/client/document/{documentId}
 */
export async function getDigioDocumentStatus(documentId: string) {
  const response = await digioClient.get(`/v2/client/document/${encodeURIComponent(documentId)}`);
  return response.data;
}

/**
 * Download signed document from Digio via /v2/client/document/download
 */
export async function downloadDigioSignedDocument(documentId: string) {
  const response = await digioClient.get("/v2/client/document/download", {
    params: { document_id: documentId },
    responseType: "arraybuffer",
  });
  return response.data;
}

/**
 * Cancel a signing request via /v2/client/document/{documentId}/cancel
 */
export async function cancelDigioDocument(documentId: string) {
  const response = await digioClient.get(`/v2/client/document/${encodeURIComponent(documentId)}/cancel`);
  return response.data;
}
