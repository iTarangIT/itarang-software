/**
 * E-259 — the per-NBFC scrap payment term.
 *
 * ONE QUESTION: does iTarang pay for a scrap consignment before the batteries
 * arrive, or after? E-258 shipped with that answer hard-coded to "as soon as a
 * rate is agreed", which is a commercial term, not a technical one, and the
 * wrong one for an NBFC nobody has traded with yet.
 *
 * ABSENCE IS AN ANSWER. An NBFC with no settings row reads as `post_lot`, and
 * the migration deliberately does not backfill rows to say so. "Nobody has
 * decided" and "somebody chose pay-after" are different facts, and only the
 * second one should show a name and a timestamp on the settings screen; a
 * backfill would have made every NBFC look like a decision that was never
 * taken. The safer term is the default because getting it wrong that way costs
 * iTarang a slower pickup, not money paid for batteries that never came.
 *
 * The setting is read at payment time, never snapshotted onto the consignment.
 * Changing an NBFC's term therefore applies to deals already mid-negotiation —
 * which is what an admin who just changed it expects, and the reason the
 * consignment screen states the term rather than assuming the reader knows it.
 */
import { db } from "@/lib/db";
import { asc, eq, sql } from "drizzle-orm";
import { nbfcScrapPaymentSettings, nbfcTenants } from "@/lib/db/schema";

export const SCRAP_PAYMENT_TIMINGS = ["pre_lot", "post_lot"] as const;
export type ScrapPaymentTiming = (typeof SCRAP_PAYMENT_TIMINGS)[number];

/** What an NBFC with no row is treated as. See the header. */
export const DEFAULT_TIMING: ScrapPaymentTiming = "post_lot";

export const TIMING_LABEL: Record<ScrapPaymentTiming, string> = {
  pre_lot: "Pay before the lot arrives",
  post_lot: "Pay after the lot arrives",
};

export const TIMING_BLURB: Record<ScrapPaymentTiming, string> = {
  pre_lot:
    "iTarang pays as soon as the rate is agreed, before the batteries are collected. Use this for NBFCs whose lots have arrived as described before.",
  post_lot:
    "The payout is blocked until an admin marks the batteries received at iTarang. This is the default for any NBFC nobody has set a term for.",
};

export interface TenantPaymentTerm {
  tenant_id: string;
  tenant_name: string;
  is_active: boolean;
  timing: ScrapPaymentTiming;
  /** False when this is the default rather than something anyone chose. */
  is_set: boolean;
  note: string | null;
  updated_at: string | null;
}

function coerce(value: string | null | undefined): ScrapPaymentTiming {
  return (SCRAP_PAYMENT_TIMINGS as readonly string[]).includes(value ?? "")
    ? (value as ScrapPaymentTiming)
    : DEFAULT_TIMING;
}

/**
 * The term for one NBFC — the function the payment path calls.
 *
 * Returns the default rather than throwing when there is no row, because a
 * missing setting must never be the reason a legitimate payout fails.
 */
export async function getScrapPaymentTiming(
  tenant_id: string,
): Promise<{ timing: ScrapPaymentTiming; is_set: boolean }> {
  const [row] = await db
    .select({ payment_timing: nbfcScrapPaymentSettings.payment_timing })
    .from(nbfcScrapPaymentSettings)
    .where(eq(nbfcScrapPaymentSettings.tenant_id, tenant_id))
    .limit(1);

  if (!row) return { timing: DEFAULT_TIMING, is_set: false };
  return { timing: coerce(row.payment_timing), is_set: true };
}

/**
 * Every NBFC with its term, for the settings screen.
 *
 * LEFT JOIN from the tenant side, not an inner join from the settings side:
 * the screen's whole job is to show the NBFCs nobody has decided about, and an
 * inner join would list only the ones already dealt with.
 */
export async function listScrapPaymentTerms(): Promise<TenantPaymentTerm[]> {
  const rows = await db
    .select({
      tenant_id: nbfcTenants.id,
      tenant_name: sql<string>`coalesce(${nbfcTenants.nbfc_legal_name}, ${nbfcTenants.display_name})`,
      is_active: nbfcTenants.is_active,
      payment_timing: nbfcScrapPaymentSettings.payment_timing,
      note: nbfcScrapPaymentSettings.note,
      updated_at: nbfcScrapPaymentSettings.updated_at,
    })
    .from(nbfcTenants)
    .leftJoin(
      nbfcScrapPaymentSettings,
      eq(nbfcScrapPaymentSettings.tenant_id, nbfcTenants.id),
    )
    .orderBy(asc(sql`coalesce(${nbfcTenants.nbfc_legal_name}, ${nbfcTenants.display_name})`));

  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    tenant_name: r.tenant_name,
    is_active: r.is_active,
    timing: coerce(r.payment_timing),
    is_set: r.payment_timing != null,
    note: r.note ?? null,
    updated_at:
      r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : (r.updated_at ?? null),
  }));
}

/**
 * Set one NBFC's term.
 *
 * An upsert on the unique tenant index rather than a read-then-write: two
 * admins on the settings screen at once would otherwise race into a duplicate
 * row that the index would reject as a 500.
 */
export async function setScrapPaymentTiming(input: {
  tenant_id: string;
  timing: ScrapPaymentTiming;
  note?: string | null;
  actor_user_id?: string | null;
}): Promise<TenantPaymentTerm> {
  const [tenant] = await db
    .select({
      id: nbfcTenants.id,
      name: sql<string>`coalesce(${nbfcTenants.nbfc_legal_name}, ${nbfcTenants.display_name})`,
      is_active: nbfcTenants.is_active,
    })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.id, input.tenant_id))
    .limit(1);

  if (!tenant) throw new Error("NOT_FOUND: no such NBFC");

  const now = new Date();
  const [row] = await db
    .insert(nbfcScrapPaymentSettings)
    .values({
      tenant_id: input.tenant_id,
      payment_timing: input.timing,
      note: input.note ?? null,
      updated_by: input.actor_user_id ?? null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: nbfcScrapPaymentSettings.tenant_id,
      set: {
        payment_timing: input.timing,
        note: input.note ?? null,
        updated_by: input.actor_user_id ?? null,
        updated_at: now,
      },
    })
    .returning();

  return {
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    is_active: tenant.is_active,
    timing: coerce(row.payment_timing),
    is_set: true,
    note: row.note ?? null,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : null,
  };
}
