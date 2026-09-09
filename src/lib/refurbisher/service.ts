/**
 * E-292 — the refurbisher partner directory (refurbish flow v3, step 10).
 *
 * "Onboarded like recyclers (P Camp etc.); 1–2 partners to start, same flow."
 * A refurbisher is a small row — name, contact, address, GSTIN — plus one
 * portal login issued by issueRefurbisherCredentials() (credentials.ts).
 * Admin assigns a lot to one of these; the partner works it in
 * /refurbisher-portal.
 */
import { db } from "@/lib/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { refurbishers, refurbishmentLots, users } from "@/lib/db/schema";

export interface RefurbisherRow {
  id: string;
  name: string;
  contact_name: string | null;
  email: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  gstin: string | null;
  notes: string | null;
  is_active: boolean;
  credential_dispatch_status: string | null;
  credential_dispatched_at: string | null;
  credential_last_error: string | null;
  /** Does a users row with this refurbisher_id exist (i.e. can they log in)? */
  has_login: boolean;
  /** Lots currently sitting with this partner. */
  open_lots: number;
  created_at: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

function shape(r: typeof refurbishers.$inferSelect, has_login: boolean, open_lots: number): RefurbisherRow {
  return {
    id: r.id,
    name: r.name,
    contact_name: r.contact_name ?? null,
    email: r.email,
    phone: r.phone ?? null,
    address: r.address ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    gstin: r.gstin ?? null,
    notes: r.notes ?? null,
    is_active: r.is_active,
    credential_dispatch_status: r.credential_dispatch_status ?? null,
    credential_dispatched_at: iso(r.credential_dispatched_at),
    credential_last_error: r.credential_last_error ?? null,
    has_login,
    open_lots,
    created_at: iso(r.created_at) ?? "",
  };
}

export async function listRefurbishers(input: { include_inactive?: boolean } = {}): Promise<RefurbisherRow[]> {
  const rows = await db
    .select({
      r: refurbishers,
      has_login: sql<boolean>`exists(select 1 from ${users} u where u.refurbisher_id = ${refurbishers.id} and u.is_active)`,
      open_lots: sql<number>`(select count(*)::int from ${refurbishmentLots} l where l.refurbisher_id = ${refurbishers.id} and l.status in ('at_refurbisher','in_progress','costed','ready'))`,
    })
    .from(refurbishers)
    .where(input.include_inactive ? undefined : eq(refurbishers.is_active, true))
    .orderBy(asc(refurbishers.name));
  return rows.map((x) => shape(x.r, Boolean(x.has_login), Number(x.open_lots ?? 0)));
}

export async function getRefurbisher(id: string): Promise<RefurbisherRow | null> {
  const rows = await listRefurbishers({ include_inactive: true });
  return rows.find((r) => r.id === id) ?? null;
}

export interface CreateRefurbisherInput {
  name: string;
  contact_name?: string | null;
  email: string;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  gstin?: string | null;
  notes?: string | null;
  created_by?: string | null;
}

export async function createRefurbisher(input: CreateRefurbisherInput): Promise<RefurbisherRow> {
  const email = input.email.trim().toLowerCase();
  const [dup] = await db.select({ id: refurbishers.id }).from(refurbishers).where(sql`lower(${refurbishers.email}) = ${email}`).limit(1);
  if (dup) throw new Error("CONFLICT: a refurbisher with this email already exists");
  const [row] = await db
    .insert(refurbishers)
    .values({
      name: input.name.trim(),
      contact_name: input.contact_name?.trim() || null,
      email,
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      city: input.city?.trim() || null,
      state: input.state?.trim() || null,
      gstin: input.gstin?.trim().toUpperCase() || null,
      notes: input.notes?.trim() || null,
      created_by: input.created_by ?? null,
    })
    .returning();
  return shape(row, false, 0);
}

export async function updateRefurbisher(id: string, patch: Partial<Omit<CreateRefurbisherInput, "created_by">> & { is_active?: boolean }): Promise<RefurbisherRow> {
  const [existing] = await db.select().from(refurbishers).where(eq(refurbishers.id, id)).limit(1);
  if (!existing) throw new Error("NOT_FOUND: refurbisher not found");
  if (patch.email && patch.email.trim().toLowerCase() !== existing.email) {
    const [dup] = await db.select({ id: refurbishers.id }).from(refurbishers).where(and(sql`lower(${refurbishers.email}) = ${patch.email.trim().toLowerCase()}`, sql`${refurbishers.id} <> ${id}`)).limit(1);
    if (dup) throw new Error("CONFLICT: another refurbisher already uses this email");
  }
  await db
    .update(refurbishers)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.contact_name !== undefined ? { contact_name: patch.contact_name?.trim() || null } : {}),
      ...(patch.email !== undefined ? { email: patch.email.trim().toLowerCase() } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone?.trim() || null } : {}),
      ...(patch.address !== undefined ? { address: patch.address?.trim() || null } : {}),
      ...(patch.city !== undefined ? { city: patch.city?.trim() || null } : {}),
      ...(patch.state !== undefined ? { state: patch.state?.trim() || null } : {}),
      ...(patch.gstin !== undefined ? { gstin: patch.gstin?.trim().toUpperCase() || null } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
      ...(patch.is_active !== undefined ? { is_active: patch.is_active } : {}),
      updated_at: new Date(),
    })
    .where(eq(refurbishers.id, id));
  // A deactivated partner must not keep signing in.
  if (patch.is_active !== undefined) {
    await db.update(users).set({ is_active: patch.is_active, updated_at: new Date() }).where(eq(users.refurbisher_id, id));
  }
  return (await getRefurbisher(id))!;
}
