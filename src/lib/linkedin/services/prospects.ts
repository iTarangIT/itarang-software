/**
 * Prospects: one row per LinkedIn profile, deduped on the profile slug AND the
 * public URL (acceptance test 6), matched to CRM leads by name + company.
 */
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, liCampaignProspects, liProspects, liSearchResults } from "@/lib/db/schema";

import { normaliseProfileUrl } from "../lib/profile-url";
import { firstNameOf } from "../lib/render-template";
import type { ProfileRecord } from "../providers/search/types";

export type LiProspect = typeof liProspects.$inferSelect;

/** Keep the better value: a fresh non-empty one wins, an empty one never erases. */
const pick = (fresh: string | null | undefined, old: string | null | undefined) =>
  fresh && fresh.trim() ? fresh.trim() : (old ?? null);

/**
 * Upsert profile records; returns prospect ids in input order (deduped).
 * A repeated delivery (webhook retry, second search) updates in place.
 */
export async function upsertProfiles(
  records: ProfileRecord[],
  source: "brightdata" | "manual" = "brightdata",
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const key = normaliseProfileUrl(r.profileUrl);
    if (!key || seen.has(key.profileId)) continue;
    seen.add(key.profileId);

    const [existing] = await db
      .select()
      .from(liProspects)
      .where(or(eq(liProspects.profile_id, key.profileId), eq(liProspects.public_url, key.publicUrl)))
      .limit(1);

    if (existing) {
      const rawIsEnriched = !!r.raw && typeof r.raw === "object" && !("source" in (r.raw as object));
      await db
        .update(liProspects)
        .set({
          full_name: pick(r.fullName, existing.full_name),
          first_name: pick(r.firstName, existing.first_name) ?? firstNameOf(r.fullName ?? existing.full_name),
          headline: pick(r.headline, existing.headline),
          company: pick(r.company, existing.company),
          city: pick(r.city, existing.city),
          raw_json: rawIsEnriched ? (r.raw as object) : (existing.raw_json ?? (r.raw as object)),
          updated_at: new Date(),
        })
        .where(eq(liProspects.id, existing.id));
      ids.push(existing.id);
      continue;
    }

    const [row] = await db
      .insert(liProspects)
      .values({
        profile_id: key.profileId,
        public_url: key.publicUrl,
        full_name: r.fullName,
        first_name: r.firstName ?? firstNameOf(r.fullName),
        headline: r.headline,
        company: r.company,
        city: r.city,
        source,
        raw_json: (r.raw as object) ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: liProspects.id });
    if (row) {
      ids.push(row.id);
    } else {
      // Lost a race with a concurrent insert of the same profile.
      const [again] = await db
        .select({ id: liProspects.id })
        .from(liProspects)
        .where(eq(liProspects.profile_id, key.profileId))
        .limit(1);
      if (again) ids.push(again.id);
    }
  }
  await matchLeads(ids);
  return ids;
}

/** Link prospects to CRM leads by owner name + business name (best effort). */
export async function matchLeads(prospectIds: string[]): Promise<void> {
  if (!prospectIds.length) return;
  try {
    const rows = await db
      .select({ id: liProspects.id, name: liProspects.full_name, company: liProspects.company })
      .from(liProspects)
      .where(and(inArray(liProspects.id, prospectIds), sql`${liProspects.lead_id} IS NULL`));
    for (const p of rows) {
      if (!p.name || !p.company) continue;
      const [lead] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(and(ilike(leads.owner_name, p.name), ilike(leads.business_name, `%${p.company}%`)))
        .limit(1);
      if (lead) await db.update(liProspects).set({ lead_id: lead.id }).where(eq(liProspects.id, p.id));
    }
  } catch (err) {
    console.warn("[linkedin] lead match skipped:", err instanceof Error ? err.message : err);
  }
}

export type ProspectFilters = {
  runId?: string | null;
  state?: string | null;
  company?: string | null;
  city?: string | null;
  /** Headline contains (title / designation). */
  title?: string | null;
  q?: string | null;
  page?: number;
  pageSize?: number;
  /** Export: lifts the 200-row page cap (still bounded). */
  forExport?: boolean;
};

export async function listProspects(f: ProspectFilters) {
  const where: SQL[] = [];
  if (f.company) where.push(ilike(liProspects.company, `%${f.company}%`));
  if (f.city) where.push(ilike(liProspects.city, `%${f.city}%`));
  if (f.title) where.push(ilike(liProspects.headline, `%${f.title}%`));
  if (f.q) {
    const q = `%${f.q}%`;
    where.push(or(ilike(liProspects.full_name, q), ilike(liProspects.headline, q), ilike(liProspects.company, q))!);
  }
  if (f.runId) {
    where.push(
      inArray(
        liProspects.id,
        db.select({ id: liSearchResults.prospect_id }).from(liSearchResults).where(eq(liSearchResults.run_id, f.runId)),
      ),
    );
  }
  if (f.state) {
    where.push(
      inArray(
        liProspects.id,
        db
          .select({ id: liCampaignProspects.prospect_id })
          .from(liCampaignProspects)
          .where(eq(liCampaignProspects.state, f.state)),
      ),
    );
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), f.forExport ? 10_000 : 200);
  const page = Math.max(f.page ?? 1, 1);
  const cond = where.length ? and(...where) : undefined;
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(liProspects)
      .where(cond)
      .orderBy(desc(liProspects.created_at))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(liProspects).where(cond),
  ]);
  const contacted = await contactedMap(rows.map((r) => r.id));
  return {
    rows: rows.map((r) => ({ ...stripRaw(r), campaigns: contacted.get(r.id) ?? [] })),
    total: Number(total),
    page,
    pageSize,
  };
}

/** prospect id → [{campaign_id, state}] — the "already contacted" flag. */
export async function contactedMap(ids: string[]) {
  const map = new Map<string, { campaign_id: string; state: string }[]>();
  if (!ids.length) return map;
  const rows = await db
    .select({
      prospect_id: liCampaignProspects.prospect_id,
      campaign_id: liCampaignProspects.campaign_id,
      state: liCampaignProspects.state,
    })
    .from(liCampaignProspects)
    .where(inArray(liCampaignProspects.prospect_id, ids));
  for (const r of rows) {
    const list = map.get(r.prospect_id) ?? [];
    list.push({ campaign_id: r.campaign_id, state: r.state });
    map.set(r.prospect_id, list);
  }
  return map;
}

export function stripRaw<T extends { raw_json?: unknown }>(row: T): Omit<T, "raw_json"> {
  const { raw_json: _r, ...rest } = row;
  return rest;
}

export async function updateProspect(
  id: string,
  patch: { do_not_contact?: boolean; do_not_contact_reason?: string | null; lead_id?: string | null },
) {
  const [row] = await db
    .update(liProspects)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(liProspects.id, id))
    .returning();
  if (!row) throw Object.assign(new Error("Prospect not found"), { status: 404 });
  if (patch.do_not_contact) await stopProspectEverywhere(id, patch.do_not_contact_reason ?? "do not contact");
  return stripRaw(row);
}

/** do_not_contact or a negative reply blocks the prospect across ALL campaigns (doc §6.4). */
export async function stopProspectEverywhere(prospectId: string, reason: string): Promise<void> {
  await db
    .update(liCampaignProspects)
    .set({ state: "stopped", stopped_reason: reason, next_action_at: null, updated_at: new Date() })
    .where(
      and(
        eq(liCampaignProspects.prospect_id, prospectId),
        inArray(liCampaignProspects.state, ["selected", "approved", "queued", "invite_sent", "accepted", "message_sent", "seen"]),
      ),
    );
}
