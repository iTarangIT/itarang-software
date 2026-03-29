import { Buffer } from "node:buffer";

const DIGIO_BASE_URL = process.env.DIGIO_BASE_URL!;
const DIGIO_CLIENT_ID = process.env.DIGIO_CLIENT_ID!;
const DIGIO_CLIENT_SECRET = process.env.DIGIO_CLIENT_SECRET!;
const DIGIO_AUDIT_TRAIL_PATH_TEMPLATE =
  process.env.DIGIO_AUDIT_TRAIL_PATH_TEMPLATE ||
  "/v2/client/document/download_audit_trail?document_id={documentId}";

function getDigioAuthHeader() {
  const token = Buffer.from(
    `${DIGIO_CLIENT_ID}:${DIGIO_CLIENT_SECRET}`
  ).toString("base64");

  return `Basic ${token}`;
}

export async function downloadDigioAuditTrail(documentId: string) {
  if (!documentId) {
    throw new Error("Digio documentId is required");
  }

  const path = DIGIO_AUDIT_TRAIL_PATH_TEMPLATE.replace(
    "{documentId}",
    encodeURIComponent(documentId)
  );

  const url = `${DIGIO_BASE_URL}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: getDigioAuthHeader(),
      Accept: "application/pdf, application/octet-stream, */*",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Digio audit trail download failed: ${response.status} ${response.statusText} ${errorText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const contentType =
    response.headers.get("content-type") || "application/pdf";

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType,
  };
}