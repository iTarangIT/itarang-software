/**
 * E-008 / E-112 — Fetch signed PDF + audit-trail PDF for an NBFC LSP agreement
 * after Digio reports COMPLETED, and persist the public URLs onto
 * `nbfc_lsp_agreements`.
 *
 * NBFC files go to the VPS local `public/nbfc-uploads/{nbfcId}/lsp-agreement/`
 * folder (matching the agreement-template / signer-identity upload routes).
 * This is NOT Supabase Storage — see CLAUDE.md and
 * `src/app/api/admin/nbfc/[nbfcId]/lsp-agreement/agreement-template/upload/route.ts`.
 *
 * Test mode: when NBFC_DIGIO_STUB=1 (and NBFC_TEST_BYPASS_SECRET is set,
 * NODE_ENV != production), we return deterministic synthetic URLs. This keeps
 * the AC tests hermetic — they don't need Digio creds or disk writes.
 */
import path from "node:path";
import fs from "node:fs/promises";
import {
  getDigioBaseUrl,
  getDigioBasicAuth,
} from "@/lib/digio/client";
import { extractSignedAgreementUrl } from "@/lib/digio/parse-status";

export interface FetchSignedLspPdfInput {
  agreementRowId: number;
  nbfcId: number;
  digioDocumentId: string;
}

export interface FetchSignedLspPdfResult {
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

async function downloadPdf(
  url: string,
  authHeader: string,
  label: string,
): Promise<Buffer | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/pdf" },
      cache: "no-store",
    });
  } catch (err) {
    console.warn("[fetchSignedLspPdf] network error", {
      label,
      url,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[fetchSignedLspPdf] download non-ok", {
      label,
      url,
      status: res.status,
      body: body.slice(0, 500),
    });
    return null;
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    const body = await res.text().catch(() => "");
    console.warn("[fetchSignedLspPdf] download returned JSON, not PDF", {
      label,
      url,
      contentType: ct,
      body: body.slice(0, 500),
    });
    return null;
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength < 100) {
    console.warn("[fetchSignedLspPdf] pdf buffer too small", {
      label,
      url,
      contentType: ct,
      byteLength: ab.byteLength,
    });
    return null;
  }
  console.info("[fetchSignedLspPdf] downloaded PDF", {
    label,
    url,
    byteLength: ab.byteLength,
  });
  return Buffer.from(ab);
}

/**
 * Two-step lookup for the signed PDF (mirrors the working dealer flow in
 * `src/lib/digio/ensure-signed-agreement.ts`):
 *
 *   1. GET /v2/client/document/{id} (JSON) and use `extractSignedAgreementUrl`
 *      to read whatever field Digio used (`signed_agreement_url`,
 *      `executed_file_url`, etc.).
 *   2. Fetch the resolved URL as a PDF.
 *   3. If either step fails, fall back to the direct
 *      `/v2/client/document/download?document_id=...` endpoint.
 *
 * The previous single-URL approach worked for `uploadpdf`-style documents
 * (dealer flow) but Digio's multi_templates API often returns JSON pointing
 * at the actual signed-PDF URL, leaving the direct download endpoint to
 * return a JSON error or empty body. This rewrite collapses both behaviors.
 */
async function fetchSignedAgreementPdf(
  baseUrl: string,
  authHeader: string,
  digioDocumentId: string,
): Promise<Buffer | null> {
  const encodedId = encodeURIComponent(digioDocumentId);

  // Step 1 — fetch status JSON to extract the signed URL.
  const statusUrl = `${baseUrl}/v2/client/document/${encodedId}`;
  try {
    const statusRes = await fetch(statusUrl, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/json" },
      cache: "no-store",
    });
    if (!statusRes.ok) {
      const body = await statusRes.text().catch(() => "");
      console.warn("[fetchSignedLspPdf] status endpoint non-ok", {
        url: statusUrl,
        status: statusRes.status,
        body: body.slice(0, 500),
      });
    } else {
      const parsed = await statusRes.json().catch(() => null);
      const extractedUrl = extractSignedAgreementUrl(parsed);
      console.info("[fetchSignedLspPdf] status response", {
        documentId: digioDocumentId,
        agreementStatus: parsed?.agreement_status ?? parsed?.status ?? null,
        extractedUrlFound: !!extractedUrl,
      });
      if (extractedUrl) {
        const fromExtracted = await downloadPdf(
          extractedUrl,
          authHeader,
          "signed:extracted",
        );
        if (fromExtracted) return fromExtracted;
      }
    }
  } catch (err) {
    console.warn("[fetchSignedLspPdf] status fetch threw", {
      url: statusUrl,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3 — direct download fallback.
  const directUrl =
    baseUrl + DOWNLOAD_PATH.replace("{documentId}", encodedId);
  return downloadPdf(directUrl, authHeader, "signed:direct");
}

async function writePdfToDisk(
  buffer: Buffer,
  nbfcId: number,
  filename: string,
): Promise<{ publicUrl: string; absPath: string }> {
  const urlDir = path.posix.join("nbfc-uploads", String(nbfcId), "lsp-agreement");
  const absDir = path.join(
    process.cwd(),
    "public",
    "nbfc-uploads",
    String(nbfcId),
    "lsp-agreement",
  );
  await fs.mkdir(absDir, { recursive: true });
  const absPath = path.join(absDir, filename);
  await fs.writeFile(absPath, buffer);
  const publicUrl = "/" + path.posix.join(urlDir, filename);
  return { publicUrl, absPath };
}

export async function fetchSignedLspPdfAndAuditTrail(
  input: FetchSignedLspPdfInput,
): Promise<FetchSignedLspPdfResult> {
  if (isTestStubMode()) {
    const base = `/nbfc-uploads/${input.nbfcId}/lsp-agreement`;
    return {
      signedPdfUrl: `${base}/signed.pdf`,
      auditTrailUrl: `${base}/audit-trail.pdf`,
      stubbed: true,
    };
  }

  const authHeader = getDigioBasicAuth();
  if (!authHeader) {
    console.warn(
      "[fetchSignedLspPdf] DIGIO_CLIENT_ID/SECRET not set — cannot download",
    );
    return { signedPdfUrl: null, auditTrailUrl: null, stubbed: false };
  }

  const baseUrl = getDigioBaseUrl();
  const auditUrl =
    baseUrl +
    AUDIT_TRAIL_PATH.replace(
      "{documentId}",
      encodeURIComponent(input.digioDocumentId),
    );

  const [signedBuffer, auditBuffer] = await Promise.all([
    fetchSignedAgreementPdf(baseUrl, authHeader, input.digioDocumentId),
    downloadPdf(auditUrl, authHeader, "audit:direct"),
  ]);

  let signedPdfUrl: string | null = null;
  let auditTrailUrl: string | null = null;

  if (signedBuffer) {
    const out = await writePdfToDisk(signedBuffer, input.nbfcId, "signed.pdf");
    signedPdfUrl = out.publicUrl;
  }
  if (auditBuffer) {
    const out = await writePdfToDisk(
      auditBuffer,
      input.nbfcId,
      "audit-trail.pdf",
    );
    auditTrailUrl = out.publicUrl;
  }

  return { signedPdfUrl, auditTrailUrl, stubbed: false };
}
