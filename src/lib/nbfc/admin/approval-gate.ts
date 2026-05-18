/**
 * E-001 — server-side guard for the NBFC final approval gate.
 *
 * `evaluateApprovalReadiness` returns the booleans + reasons that both the
 * readiness API and the approve API consult. The approve route MUST re-run
 * this check (UI disable is advisory only, per non_functional in the unit
 * YAML).
 */
import { db } from "@/lib/db";
import { and, desc, eq } from "drizzle-orm";
import {
  nbfc,
  nbfcComplianceDocuments,
  nbfcCorrectionItems,
  nbfcCorrectionRounds,
  nbfcLspAgreements,
} from "@/lib/db/schema";
import { REQUIRED_NBFC_DOC_TYPES } from "./required-docs";
import type { EntityVerificationType } from "./entity-kyc";
import type { DirectorVerificationType } from "./director-kyc";

// KYC verification is no longer a CEO-side approval gate — admin runs KYC
// out-of-band on /admin/nbfc/[id]/kyc-review. The CEO approval surface
// trusts the admin's submission and reads only docs + LSP state.

export type PendingCorrections = {
  roundId: number;
  roundNumber: number;
  openItemCount: number;
};

export type ReadinessResult = {
  canApprove: boolean;
  missingDocs: string[];
  lspAgreementStatus: string;
  missingEntityKyc: EntityVerificationType[];
  missingDirectorKyc: DirectorVerificationType[];
  reason: string | null;
  pendingCorrections: PendingCorrections | null;
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
      missingEntityKyc: [],
      missingDirectorKyc: [],
      reason: "NBFC not found",
      pendingCorrections: null,
    };
  }

  // 2) Compliance documents — every required type must have at least one
  // non-rejected upload. (CEO doc verification has been removed; uploads
  // are accepted as-is by the admin self-serve flow.)
  const docs = await db
    .select({
      document_type: nbfcComplianceDocuments.document_type,
      status: nbfcComplianceDocuments.status,
    })
    .from(nbfcComplianceDocuments)
    .where(eq(nbfcComplianceDocuments.nbfc_id, nbfcId));
  const uploadedTypes = new Set(
    docs.filter((d) => d.status !== "rejected").map((d) => d.document_type),
  );
  const missingDocs = REQUIRED_NBFC_DOC_TYPES.filter(
    (t) => !uploadedTypes.has(t),
  );

  // 3) LSP agreement — must be COMPLETED.
  const [lsp] = await db
    .select({ agreement_status: nbfcLspAgreements.agreement_status })
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.nbfc_id, nbfcId))
    .orderBy(nbfcLspAgreements.id)
    .limit(1);
  const lspAgreementStatus = lsp?.agreement_status ?? "MISSING";

  // KYC gates removed from CEO approval — admin owns KYC verification on
  // /admin/nbfc/[id]/kyc-review. The CEO surface no longer reads or blocks
  // on entity/director KYC state.

  // In the new pre-Digio CEO-approval flow, the agreement is in
  // PENDING_CEO_VERIFICATION at the time CEO approves — Digio is invoked
  // *after* approval, not before it. So the approve gate accepts both the
  // pre-Digio bundle state and any terminal signed state.
  const APPROVABLE_LSP_STATUSES = new Set([
    "PENDING_CEO_VERIFICATION",
    "COMPLETED",
    "SIGNED",
  ]);

  // E-111 — block approval when the latest correction round still has
  // pending CEO-flagged items. The CEO can't approve while their own
  // outstanding requests haven't been addressed by the admin.
  // Wrapped so the gate still evaluates if E-111 tables aren't applied yet.
  let pendingCorrections: PendingCorrections | null = null;
  try {
    const [latestRound] = await db
      .select({
        id: nbfcCorrectionRounds.id,
        round_number: nbfcCorrectionRounds.round_number,
        status: nbfcCorrectionRounds.status,
      })
      .from(nbfcCorrectionRounds)
      .where(eq(nbfcCorrectionRounds.nbfc_id, nbfcId))
      .orderBy(desc(nbfcCorrectionRounds.round_number))
      .limit(1);

    if (latestRound && latestRound.status === "open") {
      const pendingItems = await db
        .select({ id: nbfcCorrectionItems.id })
        .from(nbfcCorrectionItems)
        .where(
          and(
            eq(nbfcCorrectionItems.round_id, latestRound.id),
            eq(nbfcCorrectionItems.resolution_status, "pending"),
          ),
        );
      pendingCorrections = {
        roundId: latestRound.id,
        roundNumber: latestRound.round_number,
        openItemCount: pendingItems.length,
      };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[E-111] correction round lookup failed in approval gate — migration not applied?",
      err instanceof Error ? err.message : err,
    );
  }

  let reason: string | null = null;
  if (
    pendingCorrections &&
    pendingCorrections.openItemCount > 0
  ) {
    reason = `Pending CEO-flagged corrections: ${pendingCorrections.openItemCount} item${
      pendingCorrections.openItemCount === 1 ? "" : "s"
    } not yet resolved.`;
  } else if (missingDocs.length > 0) {
    reason = `Required compliance documents missing: ${missingDocs.join(", ")}`;
  } else if (!APPROVABLE_LSP_STATUSES.has(lspAgreementStatus)) {
    reason = "Agreement bundle missing or not in a reviewable state.";
  }

  const blockedByCorrections =
    !!pendingCorrections && pendingCorrections.openItemCount > 0;

  return {
    exists: true,
    currentStatus: row.status,
    canApprove:
      !blockedByCorrections &&
      missingDocs.length === 0 &&
      APPROVABLE_LSP_STATUSES.has(lspAgreementStatus),
    missingDocs: [...missingDocs],
    lspAgreementStatus,
    missingEntityKyc: [],
    missingDirectorKyc: [],
    reason,
    pendingCorrections,
  };
}
