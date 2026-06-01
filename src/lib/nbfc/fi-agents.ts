/**
 * FI Agent Directory helpers — BRD Addendum V0.3.1 §10.5/§10.9.3.
 *
 * A lightweight per-NBFC directory of field agents. Agents are NOT iTarang
 * users (no login) — these are contact records used for single-use link
 * dispatch (§10.6) and Coordinator selfie reference comparison (§10.7). All
 * helpers are tenant-scoped so one NBFC can never read/write another's agents.
 */
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcFiAgents } from "@/lib/db/schema";

export type FiAgent = typeof nbfcFiAgents.$inferSelect;
export type FiChannel = "email" | "sms" | "whatsapp";

export async function listFiAgents(tenantId: string, opts?: { activeOnly?: boolean }): Promise<FiAgent[]> {
  const where = opts?.activeOnly
    ? and(eq(nbfcFiAgents.tenant_id, tenantId), eq(nbfcFiAgents.active, true))
    : eq(nbfcFiAgents.tenant_id, tenantId);
  return db.select().from(nbfcFiAgents).where(where).orderBy(asc(nbfcFiAgents.name));
}

/** Single agent, tenant-scoped (returns null if it belongs to another NBFC). */
export async function getFiAgent(id: string, tenantId: string): Promise<FiAgent | null> {
  const rows = await db
    .select()
    .from(nbfcFiAgents)
    .where(and(eq(nbfcFiAgents.id, id), eq(nbfcFiAgents.tenant_id, tenantId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface FiAgentInput {
  name: string;
  phone: string;
  email?: string | null;
  city?: string | null;
  preferred_channel?: FiChannel;
  reference_photo_url?: string | null;
}

export async function createFiAgent(tenantId: string, nbfcId: number, input: FiAgentInput): Promise<FiAgent> {
  const now = new Date();
  const [row] = await db
    .insert(nbfcFiAgents)
    .values({
      tenant_id: tenantId,
      nbfc_id: nbfcId,
      name: input.name.trim(),
      phone: input.phone.trim(),
      email: input.email?.trim() || null,
      city: input.city?.trim() || null,
      preferred_channel: input.preferred_channel ?? "email",
      reference_photo_url: input.reference_photo_url?.trim() || null,
      active: true,
      created_at: now,
      updated_at: now,
    })
    .returning();
  return row;
}

export async function updateFiAgent(
  id: string,
  tenantId: string,
  patch: Partial<FiAgentInput> & { active?: boolean },
): Promise<FiAgent | null> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.phone !== undefined) set.phone = patch.phone.trim();
  if (patch.email !== undefined) set.email = patch.email?.trim() || null;
  if (patch.city !== undefined) set.city = patch.city?.trim() || null;
  if (patch.preferred_channel !== undefined) set.preferred_channel = patch.preferred_channel;
  if (patch.reference_photo_url !== undefined) set.reference_photo_url = patch.reference_photo_url?.trim() || null;
  if (patch.active !== undefined) set.active = patch.active;

  const [row] = await db
    .update(nbfcFiAgents)
    .set(set)
    .where(and(eq(nbfcFiAgents.id, id), eq(nbfcFiAgents.tenant_id, tenantId)))
    .returning();
  return row ?? null;
}

/** Soft-delete: agents are referenced by past attempts, so we deactivate. */
export async function deactivateFiAgent(id: string, tenantId: string): Promise<FiAgent | null> {
  return updateFiAgent(id, tenantId, { active: false });
}
