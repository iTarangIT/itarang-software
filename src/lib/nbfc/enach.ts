/**
 * E-NACH mandate helpers — BRD Addendum V0.2 §9 (Model B2-B).
 *
 * iTarang keeps its own canonical states (§9.3); the provider's raw status is
 * stored separately and never branched on. E-NACH runs for the WINNING NBFC
 * only, in Stage 2 (§9.1), and — when On for that NBFC and not waived — a
 * `registered` mandate is a HARD disbursal gate (§9.4).
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enachMandates, nbfcLeadAssignments } from "@/lib/db/schema";
import { resolveServiceOptIn } from "@/lib/nbfc/service-opt-in";

export const ENACH_STATES = [
  "not_applicable",
  "pending",
  "in_progress",
  "registered",
  "failed",
  "skipped",
] as const;
export type EnachState = (typeof ENACH_STATES)[number];

/** Day count after which an unpresented mandate is flagged stale (§9.4). */
export const ENACH_STALE_RISK_DAYS = 90;

/** Generates a unique, opaque correlation ref for the B2-B callback contract. */
export function generateEnachRef(leadId: string): string {
  const tail = leadId.replace(/[^a-zA-Z0-9]/g, "").slice(-12) || "lead";
  return `ITR-ENACH-${tail}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`.toUpperCase();
}

/**
 * Resolves the lead's winning NBFC assignment (status='selected'). E-NACH is
 * winner-only (§9.1), so there is at most one. Returns null if no winner yet.
 */
export async function getWinningAssignment(leadId: string) {
  const rows = await db
    .select({
      id: nbfcLeadAssignments.id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      tenant_id: nbfcLeadAssignments.tenant_id,
      snapshot: nbfcLeadAssignments.service_config_snapshot,
    })
    .from(nbfcLeadAssignments)
    .where(
      and(eq(nbfcLeadAssignments.lead_id, leadId), eq(nbfcLeadAssignments.status, "selected")),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Latest (operative) mandate row for a (lead, nbfc) — retries create new rows. */
export async function getLatestMandate(leadId: string, nbfcId: number) {
  const rows = await db
    .select()
    .from(enachMandates)
    .where(and(eq(enachMandates.lead_id, leadId), eq(enachMandates.nbfc_id, nbfcId)))
    .orderBy(desc(enachMandates.created_at))
    .limit(1);
  return rows[0] ?? null;
}

export interface EnachGate {
  required: boolean;
  satisfied: boolean;
  status: EnachState | null;
  reason: string;
  attempts: number;
}

/**
 * Evaluates the E-NACH disbursal gate for a lead (§9.4). Whether E-NACH applies
 * comes from the winning NBFC's LIVE Service Opt-In (resolveServiceOptIn) — an
 * NBFC that switches E-NACH off stops being gated on it, in-flight leads
 * included. The lead's snapshot still governs the handoff mechanics.
 *
 *   - No winner / E-NACH off for that NBFC → not required, satisfied.
 *   - Latest mandate 'registered' or 'skipped' (waived) → satisfied.
 *   - Otherwise → gated (disbursal cannot proceed).
 */
export async function evaluateEnachGate(leadId: string): Promise<EnachGate> {
  const winner = await getWinningAssignment(leadId);
  if (!winner) {
    return { required: false, satisfied: true, status: null, reason: "No winning NBFC selected.", attempts: 0 };
  }
  // Live Service Opt-In wins over the lead's frozen snapshot (see
  // resolveServiceOptIn) — switching E-NACH off takes the gate off this lead.
  const optIn = await resolveServiceOptIn(winner.tenant_id, winner.snapshot);
  if (!optIn.enach_enabled) {
    return {
      required: false,
      satisfied: true,
      status: "not_applicable",
      reason: "Winning NBFC has E-NACH opt-in OFF — handled off-platform.",
      attempts: 0,
    };
  }
  const all = await db
    .select({ status: enachMandates.status })
    .from(enachMandates)
    .where(and(eq(enachMandates.lead_id, leadId), eq(enachMandates.nbfc_id, winner.nbfc_id)));
  const latest = await getLatestMandate(leadId, winner.nbfc_id);
  const status = (latest?.status ?? null) as EnachState | null;
  const satisfied = status === "registered" || status === "skipped";
  return {
    required: true,
    satisfied,
    status,
    attempts: all.length,
    reason: satisfied
      ? status === "skipped"
        ? "E-NACH waived for this lead."
        : "E-NACH mandate registered."
      : "A registered E-NACH mandate is required before disbursal.",
  };
}
