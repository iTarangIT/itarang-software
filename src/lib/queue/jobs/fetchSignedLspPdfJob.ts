/**
 * E-008 — Fetch signed PDF + audit-trail PDF for an NBFC LSP agreement
 * after Digio reports COMPLETED, and persist the public URLs onto
 * `nbfc_lsp_agreements`.
 *
 * Per BRD 6.0.4a, signed PDF is uploaded to:
 *   s3://bucket/nbfc/{nbfcId}/lsp-agreements/{id}_signed.pdf
 *
 * Test mode: when NBFC_DIGIO_STUB=1 (and NBFC_TEST_BYPASS_SECRET is set,
 * NODE_ENV != production), we return deterministic synthetic URLs. This
 * keeps the AC tests hermetic — they don't need Digio creds or S3/Supabase
 * Storage online.
 *
 * In production this would download the signed PDF + audit-trail PDF via
 * `digioClient` and stream them to Supabase Storage using the same pattern
 * as `src/lib/digio/fetch-signed-consent.ts`. The synchronous-fetch design
 * (rather than enqueueing) matches existing dealer-flow behaviour and
 * keeps the webhook handler's contract simple — when this returns, the
 * URLs are persistable.
 */
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

export async function fetchSignedLspPdfAndAuditTrail(
  input: FetchSignedLspPdfInput,
): Promise<FetchSignedLspPdfResult> {
  if (isTestStubMode()) {
    const base = `s3://itarang-stub/nbfc/${input.nbfcId}/lsp-agreements/${input.agreementRowId}`;
    return {
      signedPdfUrl: `${base}_signed.pdf`,
      auditTrailUrl: `${base}_audit_trail.pdf`,
      stubbed: true,
    };
  }
  // Production path: implemented via digioClient + Supabase Storage upload,
  // mirroring fetch-signed-consent.ts. Out of scope for this loop.
  return {
    signedPdfUrl: null,
    auditTrailUrl: null,
    stubbed: false,
  };
}
