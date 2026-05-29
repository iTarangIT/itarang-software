/**
 * Field Investigation helpers — BRD Addendum V0.2 §6.3.
 *
 * Internal NBFC workflow, one row per (lead × NBFC), run as a Stage-1 track
 * across every picked NBFC. 48-hour SLA from agent assignment. Owned by the
 * FI Coordinator (any role-holder may act, §7.2). No per-lead skip (§9.2).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { fieldInvestigations } from "@/lib/db/schema";

/** SLA window from agent assignment (§6.3). */
export const FI_SLA_HOURS = 48;

export function slaDueFrom(assignedAt: Date): Date {
  return new Date(assignedAt.getTime() + FI_SLA_HOURS * 60 * 60 * 1000);
}

export async function getFiTrack(leadId: string, nbfcId: number) {
  const rows = await db
    .select()
    .from(fieldInvestigations)
    .where(and(eq(fieldInvestigations.lead_id, leadId), eq(fieldInvestigations.nbfc_id, nbfcId)))
    .limit(1);
  return rows[0] ?? null;
}
