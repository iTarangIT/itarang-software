/**
 * Loan-agreement helpers — BRD Addendum V0.2 §11 (Agreement, Document Handling).
 *
 * iTarang facilitates and files but is never a party to the loan documents
 * (§11.1). The agreement runs for the WINNING NBFC only, in Stage 2 alongside
 * E-NACH. Three signing mechanisms (§11.3): upload a signed copy, iTarang-
 * facilitated Digio e-sign, or API autofetch.
 *
 * IMPORTANT (§11.5): the signed agreement is NOT a disbursal gate — the Step-5
 * OTP is. So `evaluateAgreementGate` is advisory only: it drives the stepper
 * sub-label and never blocks sanction/disbursal. Canonical `status` mirrors the
 * §9.3 two-layer model — logic reads only canonical; provider_raw_* is audit.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcLoanAgreements } from "@/lib/db/schema";

export const AGREEMENT_STATES = [
  "pending",
  "in_progress",
  "signed",
  "failed",
  "skipped",
] as const;
export type AgreementState = (typeof AGREEMENT_STATES)[number];

export const AGREEMENT_METHODS = ["upload", "digio", "api_autofetch"] as const;
export type AgreementMethod = (typeof AGREEMENT_METHODS)[number];

/** Opaque correlation ref (mirrors generateEnachRef). */
export function generateAgreementRef(leadId: string): string {
  const tail = leadId.replace(/[^a-zA-Z0-9]/g, "").slice(-12) || "lead";
  return `ITR-AGR-${tail}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`.toUpperCase();
}

/** Latest (operative) agreement row for a (lead, nbfc) — retries make new rows. */
export async function getLatestAgreement(leadId: string, nbfcId: number) {
  const rows = await db
    .select()
    .from(nbfcLoanAgreements)
    .where(
      and(
        eq(nbfcLoanAgreements.lead_id, leadId),
        eq(nbfcLoanAgreements.nbfc_id, nbfcId),
      ),
    )
    .orderBy(desc(nbfcLoanAgreements.created_at))
    .limit(1);
  return rows[0] ?? null;
}

export interface AgreementGate {
  /** Whether an agreement step applies (a method is configured for the winner). */
  applicable: boolean;
  /** Reached a terminal-good state (signed or skipped). Advisory only (§11.5). */
  satisfied: boolean;
  status: AgreementState | null;
  method: AgreementMethod | null;
  reason: string;
}

/**
 * Advisory agreement state for the stepper sub-label. NEVER a disbursal gate
 * (§11.5 — Step-5 OTP is the hard gate). Reads the winning assignment's
 * snapshotted method via getWinningAssignment in the caller; here we resolve
 * from the latest row + the passed method.
 */
export async function evaluateAgreementGate(
  leadId: string,
  nbfcId: number | null,
  method: AgreementMethod | null,
): Promise<AgreementGate> {
  if (nbfcId == null || !method) {
    return {
      applicable: false,
      satisfied: true,
      status: null,
      method: null,
      reason: "No agreement method configured — handled off-platform.",
    };
  }
  const latest = await getLatestAgreement(leadId, nbfcId);
  const status = (latest?.status ?? null) as AgreementState | null;
  const satisfied = status === "signed" || status === "skipped";
  return {
    applicable: true,
    satisfied,
    status,
    method,
    reason: satisfied
      ? status === "skipped"
        ? "Agreement marked not required."
        : "Loan agreement signed."
      : "Agreement not yet signed (advisory — Step-5 OTP is the disbursal gate, §11.5).",
  };
}
