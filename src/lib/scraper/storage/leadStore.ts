import { db } from "@/lib/db";
import { dealerLeads, scrapedDealerLeads } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { toTenDigits } from "@/lib/ai/phone";

const CHUNK_SIZE = 100;

export interface PromotionResult {
  // Rows that actually landed in dealer_leads on this run.
  promoted: number;
  // Phones rejected by toTenDigits (non-Indian, malformed, < 10 digits, etc.)
  skippedInvalidPhone: number;
  // Phones that already existed in dealer_leads.phone (UNIQUE constraint kicked
  // in). This is the case most users find confusing — the lead "saved" but
  // didn't appear in the dialer queue.
  skippedDuplicate: number;
}

// Promote scraped leads into dealer_leads so they appear on the Leads page and
// in the AI dialer queue. Only leads with a valid phone are promoted; the
// dealer_leads.phone UNIQUE constraint prevents duplicates.
//
// Returns counters for each filter step so the caller (finalizeChunkedRun)
// can persist them and the UI can show "5 scraped, 0 promoted (5 duplicates)".
export async function promoteLeadsToDealerLeads(
  leads: { name?: string | null; phone?: string | null; city?: string | null }[],
): Promise<PromotionResult> {
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
  let skippedInvalidPhone = 0;
  // In-batch duplicate (same phone appearing twice in one promotion call).
  // Tallied into skippedDuplicate so the UI count matches the user's mental
  // model of "leads I scraped that didn't land".
  let skippedInBatchDup = 0;

  for (const lead of leads) {
    // toTenDigits validates the lead's phone is a valid Indian mobile
    // (6/7/8/9 prefix) and returns the dealer_leads-canonical 10-digit form.
    // Non-Indian / malformed phones are dropped here so they never enter the
    // AI dialer queue.
    const phone = toTenDigits(lead.phone);
    if (!phone) {
      skippedInvalidPhone += 1;
      continue;
    }
    if (seenPhones.has(phone)) {
      skippedInBatchDup += 1;
      continue;
    }
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

  if (!rows.length) {
    return {
      promoted: 0,
      skippedInvalidPhone,
      skippedDuplicate: skippedInBatchDup,
    };
  }

  let promoted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      const res = await db
        .insert(dealerLeads)
        .values(chunk)
        .onConflictDoNothing({ target: dealerLeads.phone })
        .returning({ id: dealerLeads.id });
      promoted += res.length;
    } catch (err) {
      console.error(
        `[LEAD_STORE] promote chunk ${i}–${i + chunk.length} failed:`,
        err,
      );
    }
  }

  // candidates = rows.length (passed in-batch dedup) minus what insert
  // returned. Add in-batch dups for the caller-facing count.
  const dbDuplicates = rows.length - promoted;
  return {
    promoted,
    skippedInvalidPhone,
    skippedDuplicate: skippedInBatchDup + dbDuplicates,
  };
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
            scraper_run_id: runId,
            dealer_name: lead.name ?? null,
            phone: lead.phone ?? null,
            email: lead.email ?? null,
            website: lead.website ?? null,
            location_city: lead.city ?? null,
            source_url: lead.source ?? null,
            exploration_status: "unassigned",
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