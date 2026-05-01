/**
 * E-001 — server-side guard for the NBFC final approval gate.
 *
 * `evaluateApprovalReadiness` returns the booleans + reasons that both the
 * readiness API and the approve API consult. The approve route MUST re-run
 * this check (UI disable is advisory only, per non_functional in the unit
 * YAML).
 */
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  nbfc,
  nbfcComplianceDocuments,
  nbfcLspAgreements,
} from "@/lib/db/schema";
import { REQUIRED_NBFC_DOC_TYPES } from "./required-docs";

export type ReadinessResult = {
  canApprove: boolean;
  missingDocs: string[];
  lspAgreementStatus: string;
  reason: string | null;
};

export async function evaluateApprovalReadiness(
  nbfcId: number,
): Promise<ReadinessResult & { exists: boolean; currentStatus?: string }> {
  // 1) NBFC exists?
  const [row] = await db
    .select({ id: nbfc.id, status: nbfc.status })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  if (!row) {
    return {
      exists: false,
      canApprove: false,
      missingDocs: [],
      lspAgreementStatus: "MISSING",
      reason: "NBFC not found",
    };
  }

  // 2) Compliance documents — every required type must be 'verified'.
  const docs = await db
    .select({
      document_type: nbfcComplianceDocuments.document_type,
      status: nbfcComplianceDocuments.status,
    })
    .from(nbfcComplianceDocuments)
    .where(eq(nbfcComplianceDocuments.nbfc_id, nbfcId));
  const verifiedTypes = new Set(
    docs.filter((d) => d.status === "verified").map((d) => d.document_type),
  );
  const missingDocs = REQUIRED_NBFC_DOC_TYPES.filter(
    (t) => !verifiedTypes.has(t),
  );

  // 3) LSP agreement — must be COMPLETED.
  const [lsp] = await db
    .select({ agreement_status: nbfcLspAgreements.agreement_status })
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.nbfc_id, nbfcId))
    .orderBy(nbfcLspAgreements.id)
    .limit(1);
  const lspAgreementStatus = lsp?.agreement_status ?? "MISSING";

  let reason: string | null = null;
  if (missingDocs.length > 0) {
    reason = `Required compliance documents not verified: ${missingDocs.join(", ")}`;
  } else if (lspAgreementStatus !== "COMPLETED") {
    reason = "Cannot activate until LSP Agreement is fully signed and downloaded from Digio.";
  }

  return {
    exists: true,
    currentStatus: row.status,
    canApprove: missingDocs.length === 0 && lspAgreementStatus === "COMPLETED",
    missingDocs: [...missingDocs],
    lspAgreementStatus,
    reason,
  };
}
