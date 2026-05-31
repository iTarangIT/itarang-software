/**
 * Video KYC helpers — BRD Addendum V0.2 §10.
 *
 * VKYC is a Stage-1 track that runs across EVERY NBFC the customer picked (not
 * winner-only like E-NACH, §6.1), so the acting NBFC is resolved from its own
 * lead assignment. Canonical states drive logic; the Decentro raw layer is
 * display/audit only (§9.3 pattern). There is NO per-lead skip (§9.2).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcLeadAssignments, videoKycVerifications } from "@/lib/db/schema";

export const VKYC_STATES = [
  "not_applicable",
  "pending",
  "in_progress",
  "verified",
  "failed",
] as const;
export type VkycState = (typeof VKYC_STATES)[number];

export function generateVkycRef(leadId: string): string {
  const tail = leadId.replace(/[^a-zA-Z0-9]/g, "").slice(-12) || "lead";
  return `ITR-VKYC-${tail}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`.toUpperCase();
}

type Snapshot = { vkyc_enabled?: boolean; vkyc_mode?: "own" | "itarang" | null } & Record<string, unknown>;

/**
 * The acting tenant's own assignment for this lead — the active origination
 * states (not a terminal loser). Returns null if this tenant doesn't own a
 * live assignment for the lead.
 */
export async function getActiveAssignment(leadId: string, tenantId: string) {
  const rows = await db
    .select({
      id: nbfcLeadAssignments.id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      tenant_id: nbfcLeadAssignments.tenant_id,
      status: nbfcLeadAssignments.status,
      snapshot: nbfcLeadAssignments.service_config_snapshot,
    })
    .from(nbfcLeadAssignments)
    .where(and(eq(nbfcLeadAssignments.lead_id, leadId), eq(nbfcLeadAssignments.tenant_id, tenantId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const snap = (row.snapshot ?? {}) as Snapshot;
  return { ...row, snapshot: snap };
}

/** Existing track row for (lead, nbfc), or null. */
export async function getVkycTrack(leadId: string, nbfcId: number) {
  const rows = await db
    .select()
    .from(videoKycVerifications)
    .where(and(eq(videoKycVerifications.lead_id, leadId), eq(videoKycVerifications.nbfc_id, nbfcId)))
    .limit(1);
  return rows[0] ?? null;
}
