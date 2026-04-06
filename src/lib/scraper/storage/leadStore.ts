import { db } from "@/lib/db";
import { scrapedDealerLeads } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";

const CHUNK_SIZE = 100;

export async function saveCleanLeads(leads: any[], runId: string): Promise<number> {
  if (!leads.length) return 0;

  // Bulk check existing phones in one query
  const phones = leads.map((l) => l.phone).filter(Boolean);

  const existing = phones.length
    ? await db
        .select({ phone: scrapedDealerLeads.phone })
        .from(scrapedDealerLeads)
        .where(inArray(scrapedDealerLeads.phone, phones))
    : [];

  const existingPhones = new Set(existing.map((e) => e.phone));

  const newLeads = leads.filter(
    (l) => !l.phone || !existingPhones.has(l.phone),
  );

  console.log(
    `[LEAD_STORE] ${leads.length} total → ${newLeads.length} new after DB dedup`,
  );

  if (!newLeads.length) return 0;

  let saved = 0;

  for (let i = 0; i < newLeads.length; i += CHUNK_SIZE) {
    const chunk = newLeads.slice(i, i + CHUNK_SIZE);

    try {
      await db
        .insert(scrapedDealerLeads)
        .values(
          chunk.map((lead) => ({
            id: crypto.randomUUID(),
            scraper_run_id: runId, // ✅ fix
            dealer_name: lead.name ?? null,
            phone: lead.phone ?? null,
            email: lead.email ?? null,
            website: lead.website ?? null,
            location_city: lead.city ?? null,
            address: lead.address ?? null,
            source_url: lead.source ?? null,
            exploration_status: "unexplored",
            created_at: new Date(),
            updated_at: new Date(),
          })),
        )
        .onConflictDoNothing();

      saved += chunk.length;
    } catch (err) {
      console.error(`[LEAD_STORE] chunk ${i}–${i + chunk.length} failed:`, err);
    }
  }

  return saved;
}