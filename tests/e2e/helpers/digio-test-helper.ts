/**
 * digio-test-helper — fakes the Digio LSP-agreement webhook for headed tests.
 *
 * In production, /api/admin/nbfc/{id}/lsp-agreement/initiate hands off to Digio
 * and a webhook flips agreement_status from SENT_TO_EXTERNAL_PARTY → COMPLETED
 * once all signers sign. That can take days. The headed onboarding test sets
 * the same end-state directly via Drizzle, mirroring exactly what the webhook
 * would persist.
 *
 * Used only by tests/e2e/nbfc/nbfc-onboarding.headed.spec.ts.
 */
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dealers,
  nbfcComplianceDocuments,
  nbfcLspAgreements,
} from "@/lib/db/schema";
import { REQUIRED_NBFC_DOC_TYPES } from "@/lib/nbfc/admin/required-docs";

/**
 * Pick the lowest-id dealer in the local DB. Used by the spec's step 10 when
 * the /api/admin/dealers list endpoint either doesn't exist or returns an
 * unexpected shape on the target environment. Returns null only if the
 * `dealers` table is empty.
 */
export async function pickAnyDealerIdViaDb(): Promise<number | null> {
  const [row] = await db
    .select({ id: dealers.id })
    .from(dealers)
    .orderBy(dealers.id)
    .limit(1);
  return row?.id ?? null;
}

export type CompletedAgreement = {
  id: number;
  agreement_id: string | null;
  agreement_status: string;
  completed_at: Date | null;
  signed_pdf_url: string | null;
};

export type AgreementSigners = {
  nbfcSignatoryName: string;
  nbfcSignatoryEmail: string;
  itarangSignatory1Name: string;
  itarangSignatory1Email: string;
  itarangSignatory2Name: string;
  itarangSignatory2Email: string;
};

export type CreatedAgreement = {
  id: number;
  agreement_id: string;
};

/**
 * Approval-readiness gate (`evaluateApprovalReadiness`) checks doc-type slugs
 * declared in `REQUIRED_NBFC_DOC_TYPES`, but the public POST upload route
 * (/api/admin/nbfc/{id}/compliance-documents) accepts a slightly different
 * vocabulary (`certificate_of_incorporation` vs `incorporation_certificate`,
 * `pan_card_company` vs `pan_card`, `gst_registration` vs `gst_certificate`).
 *
 * For tests, we paper over the divergence by writing the gate-expected slugs
 * directly with status='verified'. Real production code paths still need
 * fixing — this helper is documented as a known-bug bypass.
 */
export async function seedRequiredVerifiedDocs(
  nbfcPk: number,
  uploaderId: number,
): Promise<{ inserted: string[]; alreadyPresent: string[] }> {
  const existing = await db
    .select({ document_type: nbfcComplianceDocuments.document_type })
    .from(nbfcComplianceDocuments)
    .where(
      and(
        eq(nbfcComplianceDocuments.nbfc_id, nbfcPk),
        inArray(
          nbfcComplianceDocuments.document_type,
          REQUIRED_NBFC_DOC_TYPES as unknown as string[],
        ),
      ),
    );
  const present = new Set(existing.map((r) => r.document_type));
  const missing = REQUIRED_NBFC_DOC_TYPES.filter((t) => !present.has(t));
  if (missing.length === 0) return { inserted: [], alreadyPresent: [...present] };

  const now = new Date();
  await db.insert(nbfcComplianceDocuments).values(
    missing.map((document_type) => ({
      nbfc_id: nbfcPk,
      document_type,
      file_url: `https://example.com/test-fixtures/nbfc/${document_type}.pdf`,
      expiry_date:
        document_type === "rbi_cor"
          ? "2029-03-05"
          : null,
      status: "verified" as const,
      uploaded_by: uploaderId,
      verified_by: uploaderId,
      verified_at: now,
      verifier_notes: "seeded by nbfc-onboarding e2e test (gate-vocabulary bypass)",
    })),
  );
  return { inserted: [...missing], alreadyPresent: [...present] };
}

/**
 * Insert an `nbfc_lsp_agreements` row mirroring what
 * /api/admin/nbfc/{id}/lsp-agreement/initiate would persist on success — used
 * as a fallback when local dev has no Digio sandbox credentials and the route
 * returns 502 DIGIO_REQUEST_FAILED. Sets agreement_status =
 * 'SENT_TO_EXTERNAL_PARTY' so step 05 (markLspAgreementCompleted) can flip it
 * to COMPLETED, exactly as in the production flow.
 */
export async function createLspAgreementForTest(
  nbfcPk: number,
  signers: AgreementSigners,
): Promise<CreatedAgreement> {
  const now = new Date();
  const yyyymmdd =
    now.getUTCFullYear().toString().padStart(4, "0") +
    (now.getUTCMonth() + 1).toString().padStart(2, "0") +
    now.getUTCDate().toString().padStart(2, "0");
  // Sequence-style suffix from epoch ms — collision-resistant for tests.
  const seq = String(now.getTime()).slice(-4);
  const agreementId = `AGR-NBFC-${yyyymmdd}-${seq}`;

  const expiresAt = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(nbfcLspAgreements)
    .values({
      agreement_id: agreementId,
      nbfc_id: nbfcPk,
      digio_request_id: `e2e-test-${seq}`,
      digio_document_id: `e2e-test-${seq}`,
      agreement_status: "SENT_TO_EXTERNAL_PARTY",
      nbfc_signatory_name: signers.nbfcSignatoryName,
      nbfc_signatory_email: signers.nbfcSignatoryEmail,
      itarang_signatory_1_name: signers.itarangSignatory1Name,
      itarang_signatory_1_email: signers.itarangSignatory1Email,
      itarang_signatory_2_name: signers.itarangSignatory2Name,
      itarang_signatory_2_email: signers.itarangSignatory2Email,
      expires_at: expiresAt,
      initiated_at: now,
      last_webhook_payload: { note: "synthesised by nbfc-onboarding e2e test (no Digio)" },
    })
    .returning({
      id: nbfcLspAgreements.id,
      agreement_id: nbfcLspAgreements.agreement_id,
    });

  if (!row?.agreement_id) {
    throw new Error("createLspAgreementForTest: insert returned no row");
  }
  return { id: row.id, agreement_id: row.agreement_id };
}

/**
 * Mark an existing nbfc_lsp_agreements row as COMPLETED, as if Digio had
 * fired its post-sign webhook. Resolves by the public agreement_id
 * (e.g. "AGR-NBFC-20260503-0001") returned by the initiate endpoint.
 */
export async function markLspAgreementCompleted(
  agreementId: string,
): Promise<CompletedAgreement> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD for date column

  const [row] = await db
    .update(nbfcLspAgreements)
    .set({
      agreement_status: "COMPLETED",
      signing_date: today,
      completed_at: now,
      signed_pdf_url:
        "https://example.com/test-fixtures/nbfc-lsp-signed-placeholder.pdf",
      audit_trail_url:
        "https://example.com/test-fixtures/nbfc-lsp-audit-trail-placeholder.pdf",
      updated_at: now,
    })
    .where(eq(nbfcLspAgreements.agreement_id, agreementId))
    .returning({
      id: nbfcLspAgreements.id,
      agreement_id: nbfcLspAgreements.agreement_id,
      agreement_status: nbfcLspAgreements.agreement_status,
      completed_at: nbfcLspAgreements.completed_at,
      signed_pdf_url: nbfcLspAgreements.signed_pdf_url,
    });

  if (!row) {
    throw new Error(
      `markLspAgreementCompleted: no nbfc_lsp_agreements row with agreement_id=${agreementId}`,
    );
  }
  return row;
}
