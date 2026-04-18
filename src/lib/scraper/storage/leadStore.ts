import { db } from "@/lib/db";
import { dealerLeads, scrapedDealerLeads } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

const CHUNK_SIZE = 100;

// Normalize phone to 10-digit form to match the dealer_leads uniqueness semantics.
// Returns null for anything that doesn't look like a valid Indian mobile.
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  const trimmed = digits.length > 10 ? digits.slice(-10) : digits;
  if (trimmed.length !== 10) return null;
  if (!/^[6-9]/.test(trimmed)) return null;
  return trimmed;
}

// Promote scraped leads into dealer_leads so they appear on the Leads page and
// in the AI dialer queue. Only leads with a valid phone are promoted; the
// dealer_leads.phone UNIQUE constraint prevents duplicates.
export async function promoteLeadsToDealerLeads(
  leads: { name?: string | null; phone?: string | null; city?: string | null }[],
): Promise<number> {
  const rows: {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string;
    location: string | null;
    language: string;
    current_status: string;
    total_attempts: number;
    follow_up_history: any;
    created_at: Date;
  }[] = [];

  const seenPhones = new Set<string>();

  for (const lead of leads) {
    const phone = normalizePhone(lead.phone);
    if (!phone) continue;
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);

    rows.push({
      id: `L-${nanoid(8)}`,
      dealer_name: lead.name?.trim() || null,
      shop_name: lead.name?.trim() || null,
      phone,
      location: lead.city?.trim() || null,
      language: "hindi",
      current_status: "new",
      total_attempts: 0,
      follow_up_history: [],
      created_at: new Date(),
    });
  }

  if (!rows.length) return 0;

  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      const res = await db
        .insert(dealerLeads)
        .values(chunk)
        .onConflictDoNothing({ target: dealerLeads.phone })
        .returning({ id: dealerLeads.id });
      inserted += res.length;
    } catch (err) {
      console.error(
        `[LEAD_STORE] promote chunk ${i}–${i + chunk.length} failed:`,
        err,
      );
    }
  }

  return inserted;
}

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