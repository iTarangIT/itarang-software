/**
 * E-262 — Recovery Agent Directory.
 *
 * A per-NBFC list of the people who physically collect a flagged battery. They
 * are NOT iTarang users and have no login: an agent is somebody you dispatch to
 * with a single-use link, not an account you provision. That is the same stance
 * `fi-agents.ts` takes for field-investigation agents, and this file is its
 * sibling rather than a generalisation of it — a repossession agent and a KYC
 * verifier are different people doing different jobs, and one merged directory
 * would put the wrong names in both pickers.
 *
 * Every helper is tenant-scoped, so one NBFC can never read or write another's
 * agents.
 */
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcRecoveryAgents } from "@/lib/db/schema";

export type RecoveryAgent = typeof nbfcRecoveryAgents.$inferSelect;
export type RecoveryChannel = "email" | "sms" | "whatsapp";

export const RECOVERY_CHANNELS = ["email", "sms", "whatsapp"] as const;

export async function listRecoveryAgents(
  tenantId: string,
  opts?: { activeOnly?: boolean },
): Promise<RecoveryAgent[]> {
  const where = opts?.activeOnly
    ? and(
        eq(nbfcRecoveryAgents.tenant_id, tenantId),
        eq(nbfcRecoveryAgents.active, true),
      )
    : eq(nbfcRecoveryAgents.tenant_id, tenantId);
  return db
    .select()
    .from(nbfcRecoveryAgents)
    .where(where)
    .orderBy(asc(nbfcRecoveryAgents.name));
}

/** Single agent, tenant-scoped (null if it belongs to another NBFC). */
export async function getRecoveryAgent(
  id: string,
  tenantId: string,
): Promise<RecoveryAgent | null> {
  const rows = await db
    .select()
    .from(nbfcRecoveryAgents)
    .where(
      and(
        eq(nbfcRecoveryAgents.id, id),
        eq(nbfcRecoveryAgents.tenant_id, tenantId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface RecoveryAgentInput {
  name: string;
  phone: string;
  email?: string | null;
  city?: string | null;
  /** Free text — "Ranchi + 60km". Helps a coordinator pick; not a geofence. */
  coverage_area?: string | null;
  preferred_channel?: RecoveryChannel;
  reference_photo_url?: string | null;
}

export async function createRecoveryAgent(
  tenantId: string,
  nbfcId: number | null,
  input: RecoveryAgentInput,
): Promise<RecoveryAgent> {
  const now = new Date();
  const [row] = await db
    .insert(nbfcRecoveryAgents)
    .values({
      tenant_id: tenantId,
      nbfc_id: nbfcId,
      name: input.name.trim(),
      phone: input.phone.trim(),
      email: input.email?.trim() || null,
      city: input.city?.trim() || null,
      coverage_area: input.coverage_area?.trim() || null,
      preferred_channel: input.preferred_channel ?? "email",
      reference_photo_url: input.reference_photo_url?.trim() || null,
      active: true,
      created_at: now,
      updated_at: now,
    })
    .returning();
  return row;
}

export async function updateRecoveryAgent(
  id: string,
  tenantId: string,
  patch: Partial<RecoveryAgentInput> & { active?: boolean },
): Promise<RecoveryAgent | null> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.phone !== undefined) set.phone = patch.phone.trim();
  if (patch.email !== undefined) set.email = patch.email?.trim() || null;
  if (patch.city !== undefined) set.city = patch.city?.trim() || null;
  if (patch.coverage_area !== undefined) {
    set.coverage_area = patch.coverage_area?.trim() || null;
  }
  if (patch.preferred_channel !== undefined) {
    set.preferred_channel = patch.preferred_channel;
  }
  if (patch.reference_photo_url !== undefined) {
    set.reference_photo_url = patch.reference_photo_url?.trim() || null;
  }
  if (patch.active !== undefined) set.active = patch.active;

  const [row] = await db
    .update(nbfcRecoveryAgents)
    .set(set)
    .where(
      and(
        eq(nbfcRecoveryAgents.id, id),
        eq(nbfcRecoveryAgents.tenant_id, tenantId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Soft delete. Past assignments name the agent who did the job, so a removed
 * row would blank out history — and a collection nobody can attribute is not
 * much of an audit trail. Deactivating takes them out of the picker, which is
 * the only thing anyone actually wants.
 */
export async function deactivateRecoveryAgent(
  id: string,
  tenantId: string,
): Promise<RecoveryAgent | null> {
  return updateRecoveryAgent(id, tenantId, { active: false });
}
