import { db } from "@/lib/db";
import { dealerLeads, scrapedDealerLeads } from "@/lib/db/schema";
import { inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { toTenDigits } from "@/lib/ai/phone";
import { normalizeRegion } from "@/lib/locations/normalize";
import type { PlaceComponents } from "@/lib/scraper/query/sources/googlePlaces";
import { loadExistingByPhone, normalizePhone } from "@/lib/leads/dedupe";
import { recordLeadCreated, recordReinquiry } from "@/lib/leads/leadSource";

const CHUNK_SIZE = 100;
const REINQUIRY_WINDOW_DAYS = 30;

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
// in the AI dialer queue. Only leads with a valid phone are promoted.
//
// ID 81 (source on every lead). This is the path a scrape run actually uses —
// the Scraper tab never calls /api/scraper-leads/[id]/promote — so it gets the
// same three things as every other door:
//   - the SHARED duplicate check (last 10 digits, dedupe.ts). The phone UNIQUE
//     constraint compares raw text, so a dealer stored as +91XXXXXXXXXX was
//     not seen and got a second copy.
//   - door = scraper, origin = scraped_listing, and "Lead created".
//   - "Re-inquiry via scraper" on a dealer we already have — at most once per
//     REINQUIRY_WINDOW_DAYS, so a weekly re-scrape of one city does not write
//     a line on every known dealer every week.
//
// Returns counters for each filter step so the caller (finalizeChunkedRun)
// can persist them and the UI can show "5 scraped, 0 promoted (5 duplicates)".
export async function promoteLeadsToDealerLeads(
  leads: {
    name?: string | null;
    phone?: string | null;
    city?: string | null;
    state?: string | null;
    address?: string | null;
    components?: PlaceComponents;
  }[],
): Promise<PromotionResult> {
  const rows: {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string;
    location: string | null;
    state: string | null;
    city: string | null;
    area: string | null;
    pincode: string | null;
    country: string;
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

    // Region hierarchy resolution via the central normalizeRegion service,
    // which prefers Google addressComponents (when present), then alias
    // lookups against the DB-backed cities/city_aliases tables, then
    // legacy regex parsing as a last resort. When normalizeRegion finds a
    // Google-validated city that isn't in cities yet, it auto-inserts the
    // row with source='google_places' so the AI dialer region tree picks
    // it up immediately.
    const region = await normalizeRegion({
      components: lead.components,
      rawCity: lead.city ?? null,
      rawState: lead.state ?? null,
      address: lead.address ?? null,
    });

    rows.push({
      id: `L-${nanoid(8)}`,
      dealer_name: lead.name?.trim() || null,
      shop_name: lead.name?.trim() || null,
      phone,
      // Keep `location` populated for the legacy /api/dealer-leads/locations
      // endpoint and any code still reading it. New code reads city/state.
      location: region.city,
      state: region.state,
      city: region.city,
      area: region.area,
      pincode: region.pincode,
      country: region.country,
      language: "hindi",
      current_status: "new",
      total_attempts: 0,
      follow_up_history: [],
      created_at: new Date(),
    });
  }

  // ID 81: the shared duplicate check, on the last 10 digits.
  const existing = await loadExistingByPhone(
    rows.map((r) => normalizePhone(r.phone)).filter((p): p is string => !!p),
  );
  const known: { id: string; name: string | null }[] = [];
  const fresh = rows.filter((r) => {
    const hit = existing.get(normalizePhone(r.phone) ?? "");
    if (hit) known.push({ id: hit.id, name: r.dealer_name });
    return !hit;
  });
  await logScraperReinquiries(known);
  rows.splice(0, rows.length, ...fresh);

  if (!rows.length) {
    return {
      promoted: 0,
      skippedInvalidPhone,
      skippedDuplicate: skippedInBatchDup + known.length,
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
      await stampScraperSource(res.map((r) => r.id));
    } catch (err) {
      console.error(
        `[LEAD_STORE] promote chunk ${i}–${i + chunk.length} failed:`,
        err,
      );
    }
  }

  // candidates = rows.length (passed in-batch dedup) minus what insert
  // returned. Add in-batch dups and the dealers we already had.
  const dbDuplicates = rows.length - promoted;
  return {
    promoted,
    skippedInvalidPhone,
    skippedDuplicate: skippedInBatchDup + known.length + dbDuplicates,
  };
}

/**
 * ID 81: door + origin on the rows a run just inserted, then "Lead created" on
 * each. Best-effort: E-314 columns are not in schema.ts, and a failed stamp
 * must never lose a promoted lead.
 */
async function stampScraperSource(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db.execute(sql`
      UPDATE dealer_leads
         SET source_door = COALESCE(source_door, 'scraper'),
             source_origin = COALESCE(source_origin, 'scraped_listing')
       WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    `);
  } catch (err) {
    console.warn("[LEAD_STORE] source not stamped (E-314 applied?):", err instanceof Error ? err.message : err);
  }
  for (const id of ids) {
    try {
      await recordLeadCreated(db, { leadId: id, actorId: null, door: "scraper", ownerId: null });
    } catch (err) {
      console.warn(`[LEAD_STORE] "Lead created" not recorded for ${id}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** ID 81: "Re-inquiry via scraper" on known dealers, once per window per lead. */
async function logScraperReinquiries(known: { id: string; name: string | null }[]): Promise<void> {
  const ids = [...new Set(known.map((k) => k.id))];
  if (ids.length === 0) return;
  let recent = new Set<string>();
  try {
    const rows = (await db.execute<{ id: string }>(sql`
      SELECT DISTINCT dealer_lead_id AS id
        FROM lead_touchpoints
       WHERE touchpoint_type = 'lead_reinquiry'
         AND performed_at >= NOW() - make_interval(days => ${REINQUIRY_WINDOW_DAYS})
         AND dealer_lead_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    `)) as unknown as Array<{ id: string }>;
    recent = new Set(rows.map((r) => r.id));
  } catch (err) {
    console.warn("[LEAD_STORE] re-inquiry window check failed:", err instanceof Error ? err.message : err);
    return;
  }
  const seen = new Set<string>();
  for (const k of known) {
    if (recent.has(k.id) || seen.has(k.id)) continue;
    seen.add(k.id);
    await recordReinquiry({ leadId: k.id, door: "scraper", actorId: null, note: k.name });
  }
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
            location_state: lead.state ?? null,
            source_url: lead.source ?? null,
            // Persist the full upstream address (Google Places
            // `formattedAddress`, Apify `address`) into raw_data so the
            // leads UI / xlsx export can show "Shop No 1,2,3, …, Nashik
            // Road, Nashik, Maharashtra 422101, India" instead of just the
            // parsed city. Older rows have NULL here; the leads API
            // falls back to scraper_raw via COALESCE.
            raw_data: lead.address ? { address: lead.address } : null,
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