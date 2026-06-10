/**
 * Fetch the signed borrower loan-agreement PDF + audit trail from the eSign
 * provider (Digio) after COMPLETED, and cache them in the private
 * `nbfc-documents` bucket under lead-scoped keys. Lead-scoped sibling of
 * fetchSignedLspPdfAndAuditTrail (LSP onboarding).
 *
 * Test mode: NBFC_DIGIO_STUB=1 (+ NBFC_TEST_BYPASS_SECRET, non-prod) returns
 * deterministic synthetic URLs so AC tests stay hermetic.
 */
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import { getDigioBaseUrl, getDigioBasicAuth } from "@/lib/digio/client";
import { extractSignedAgreementUrl } from "@/lib/digio/parse-status";

export interface FetchSignedAgreementInput {
  leadId: string;
  digioDocumentId: string;
  // E-166 — when an NBFC uses their OWN Digio account, the adapter passes its
  // base URL + Basic-auth header here. Omitted ⇒ iTarang's global Digio creds.
  override?: { baseUrl: string; authHeader: string };
}
export interface FetchSignedAgreementResult {
  signedPdfUrl: string | null;
  auditTrailUrl: string | null;
  stubbed: boolean;
}

function isTestStubMode(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    !!process.env.NBFC_TEST_BYPASS_SECRET &&
    process.env.NBFC_DIGIO_STUB === "1"
  );
}

const DOWNLOAD_PATH =
  process.env.DIGIO_SIGNED_AGREEMENT_PATH_TEMPLATE ||
  "/v2/client/document/download?document_id={documentId}";
const AUDIT_TRAIL_PATH =
  process.env.DIGIO_AUDIT_TRAIL_PATH_TEMPLATE ||
  "/v2/client/document/download_audit_trail?document_id={documentId}";

async function downloadPdf(url: string, authHeader: string, label: string): Promise<Buffer | null> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: { Authorization: authHeader, Accept: "application/pdf" }, cache: "no-store" });
  } catch (err) {
    console.warn("[fetchSignedAgreement] network error", { label, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return null;
  const ab = await res.arrayBuffer();
  if (ab.byteLength < 100) return null;
  return Buffer.from(ab);
}

async function fetchSignedPdf(baseUrl: string, authHeader: string, digioDocumentId: string): Promise<Buffer | null> {
  const encodedId = encodeURIComponent(digioDocumentId);
  // Step 1 — status JSON → extract signed URL.
  try {
    const statusRes = await fetch(`${baseUrl}/v2/client/document/${encodedId}`, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/json" },
      cache: "no-store",
    });
    if (statusRes.ok) {
      const parsed = await statusRes.json().catch(() => null);
      const extractedUrl = extractSignedAgreementUrl(parsed);
      if (extractedUrl) {
        const fromExtracted = await downloadPdf(extractedUrl, authHeader, "signed:extracted");
        if (fromExtracted) return fromExtracted;
      }
    }
  } catch (err) {
    console.warn("[fetchSignedAgreement] status fetch threw", { err: err instanceof Error ? err.message : String(err) });
  }
  // Step 2 — direct download fallback.
  return downloadPdf(baseUrl + DOWNLOAD_PATH.replace("{documentId}", encodedId), authHeader, "signed:direct");
}

export async function fetchSignedLoanAgreementPdfAndAuditTrail(
  input: FetchSignedAgreementInput,
): Promise<FetchSignedAgreementResult> {
  if (isTestStubMode()) {
    const base = `/nbfc-uploads/agreements/${input.leadId}`;
    return { signedPdfUrl: `${base}/signed.pdf`, auditTrailUrl: `${base}/audit-trail.pdf`, stubbed: true };
  }

  const authHeader = input.override?.authHeader ?? getDigioBasicAuth();
  if (!authHeader) {
    console.warn("[fetchSignedAgreement] eSign provider creds not set — cannot download");
    return { signedPdfUrl: null, auditTrailUrl: null, stubbed: false };
  }
  const baseUrl = input.override?.baseUrl ?? getDigioBaseUrl();
  const auditUrl = baseUrl + AUDIT_TRAIL_PATH.replace("{documentId}", encodeURIComponent(input.digioDocumentId));

  const [signedBuffer, auditBuffer] = await Promise.all([
    fetchSignedPdf(baseUrl, authHeader, input.digioDocumentId),
    downloadPdf(auditUrl, authHeader, "audit:direct"),
  ]);

  let signedPdfUrl: string | null = null;
  let auditTrailUrl: string | null = null;
  if (signedBuffer) {
    const { url } = await putNbfcObject(`agreements/${input.leadId}/signed.pdf`, signedBuffer, "application/pdf");
    signedPdfUrl = url;
  }
  if (auditBuffer) {
    const { url } = await putNbfcObject(`agreements/${input.leadId}/audit-trail.pdf`, auditBuffer, "application/pdf");
    auditTrailUrl = url;
  }
  return { signedPdfUrl, auditTrailUrl, stubbed: false };
}
