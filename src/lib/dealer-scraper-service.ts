/**
 * Dealer Scraper Orchestration Service
 *
 * Called fire-and-forget from the API route. Handles:
 *   1. Running Firecrawl searches
 *   2. Three-layer deduplication (phone / name+city / source URL)
 *   3. Persisting new leads and dedup logs
 *   4. Updating scraper_runs status on finish
 */

import { db } from '@/lib/db';
import {
    scraperRuns,
    scrapedDealerLeads,
    scraperDedupLogs,
    leads,
    scraperSearchQueries,
} from '@/lib/db/schema';
import { generateId } from '@/lib/api-utils';
import { scrapeAllDealers, normalizePhone } from '@/lib/firecrawl';
import { enrichRecord } from '@/lib/scraper-enrichment';
import { eq, or, sql } from 'drizzle-orm';
import type { RawDealerRecord } from '@/types/scraper';

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

async function findExistingByPhone(phone: string): Promise<string | null> {
    // Check scraped_dealer_leads
    const [sdl] = await db
        .select({ id: scrapedDealerLeads.id })
        .from(scrapedDealerLeads)
        .where(eq(scrapedDealerLeads.phone, phone))
        .limit(1);

    if (sdl) return sdl.id;

    // Also check existing CRM leads (owner_contact, phone, mobile columns)
    const [crmLead] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(
            or(
                eq(leads.owner_contact, phone),
                eq(leads.phone, phone),
                eq(leads.mobile, phone)
            )
        )
        .limit(1);

    return crmLead ? crmLead.id : null;
}

async function findExistingByNameCity(
    dealerName: string,
    city: string
): Promise<string | null> {
    const [sdl] = await db
        .select({ id: scrapedDealerLeads.id })
        .from(scrapedDealerLeads)
        .where(
            sql`LOWER(${scrapedDealerLeads.dealer_name}) = LOWER(${dealerName})
            AND LOWER(${scrapedDealerLeads.location_city}) = LOWER(${city})`
        )
        .limit(1);

    return sdl ? sdl.id : null;
}

async function findExistingByUrl(sourceUrl: string): Promise<string | null> {
    // Normalise: strip query params for comparison
    const normalized = sourceUrl.split('?')[0].toLowerCase().replace(/\/$/, '');

    const [sdl] = await db
        .select({ id: scrapedDealerLeads.id })
        .from(scrapedDealerLeads)
        .where(
            sql`LOWER(SPLIT_PART(${scrapedDealerLeads.source_url}, '?', 1))
                = ${normalized}`
        )
        .limit(1);

    return sdl ? sdl.id : null;
}

// ---------------------------------------------------------------------------
// Main orchestration function (runs fully async in background)
// ---------------------------------------------------------------------------

export async function runDealerScraper(runId: string): Promise<void> {
    let totalFound = 0;
    let newLeadsSaved = 0;
    let duplicatesSkipped = 0;

    try {
        // 1. Scrape
        // Load active queries from DB, fall back to hardcoded
        const dbQueries = await db
            .select({ query_text: scraperSearchQueries.query_text })
            .from(scraperSearchQueries)
            .where(eq(scraperSearchQueries.is_active, true));

        const customQueries = dbQueries.length > 0
            ? dbQueries.map((q) => q.query_text)
            : undefined;

        const { records, queriesUsed } = await scrapeAllDealers(customQueries);
        totalFound = records.length;

        // Persist the queries used for auditability
        await db
            .update(scraperRuns)
            .set({ search_queries: queriesUsed, total_found: totalFound })
            .where(eq(scraperRuns.id, runId));

        // 2. For each record: dedup → save or log
        for (const record of records) {
            const skipResult = await checkDuplicate(record);

            if (skipResult) {
                // Duplicate found – log and skip
                await db.insert(scraperDedupLogs).values({
                    id: await generateId('DDUP', scraperDedupLogs),
                    scraper_run_id: runId,
                    raw_dealer_name: record.dealer_name,
                    raw_phone: record.phone,
                    raw_location: [record.city, record.state].filter(Boolean).join(', '),
                    raw_source_url: record.source_url,
                    skip_reason: skipResult.reason,
                    matched_lead_id: skipResult.matchedId,
                });
                duplicatesSkipped++;
            } else {
                // New lead – enrich and persist
                const enriched = enrichRecord(record);
                await db.insert(scrapedDealerLeads).values({
                    id: await generateId('SDL', scrapedDealerLeads),
                    scraper_run_id: runId,
                    dealer_name: enriched.dealer_name,
                    phone: enriched.phone ?? null,
                    location_city: enriched.city ?? null,
                    location_state: enriched.state ?? null,
                    source_url: enriched.source_url ?? null,
                    raw_data: record as unknown as Record<string, unknown>,
                    email: enriched.email ?? null,
                    gst_number: enriched.gst_number ?? null,
                    business_type: enriched.business_type ?? null,
                    products_sold: enriched.products_sold ?? null,
                    website: enriched.website ?? null,
                    quality_score: enriched.quality_score,
                    phone_valid: enriched.phone_valid,
                    exploration_status: 'unassigned',
                });
                newLeadsSaved++;
            }
        }

        // 3. Mark run as completed
        await db
            .update(scraperRuns)
            .set({
                status: 'completed',
                completed_at: new Date(),
                total_found: totalFound,
                new_leads_saved: newLeadsSaved,
                duplicates_skipped: duplicatesSkipped,
            })
            .where(eq(scraperRuns.id, runId));

        console.log(
            `[Scraper] Run ${runId} complete. ` +
            `Found: ${totalFound}, Saved: ${newLeadsSaved}, Skipped: ${duplicatesSkipped}`
        );
    } catch (err: any) {
        console.error(`[Scraper] Run ${runId} failed:`, err.message);

        await db
            .update(scraperRuns)
            .set({
                status: 'failed',
                completed_at: new Date(),
                total_found: totalFound,
                new_leads_saved: newLeadsSaved,
                duplicates_skipped: duplicatesSkipped,
                error_message: err.message ?? 'Unknown error',
            })
            .where(eq(scraperRuns.id, runId));
    }
}

// ---------------------------------------------------------------------------
// Dedup check: returns { reason, matchedId } or null if it's a new lead
// ---------------------------------------------------------------------------

interface DedupResult {
    reason: 'duplicate_phone' | 'duplicate_name_location' | 'duplicate_url';
    matchedId: string;
}

async function checkDuplicate(
    record: RawDealerRecord
): Promise<DedupResult | null> {
    // Layer 1: phone
    if (record.phone) {
        const matchId = await findExistingByPhone(record.phone);
        if (matchId) return { reason: 'duplicate_phone', matchedId: matchId };
    }

    // Layer 2: dealer_name + city
    if (record.dealer_name && record.city) {
        const matchId = await findExistingByNameCity(record.dealer_name, record.city);
        if (matchId) return { reason: 'duplicate_name_location', matchedId: matchId };
    }

    // Layer 3: source URL
    if (record.source_url) {
        const matchId = await findExistingByUrl(record.source_url);
        if (matchId) return { reason: 'duplicate_url', matchedId: matchId };
    }

    return null;
}
