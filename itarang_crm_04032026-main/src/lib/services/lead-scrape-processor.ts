/**
 * Lead scrape processor: orchestrates Google Places API → normalize → dedup → create/enrich leads.
 */

import { db } from '@/lib/db';
import { leads, scrapeBatches } from '@/lib/db/schema';
import { eq, or } from 'drizzle-orm';
import { generateId } from '@/lib/api-utils';
import { searchPlaces, type PlaceResult } from './google-places';
import { normalizePhone, classifyPhoneQuality } from '@/lib/utils/phone';

// Known Indian states for address parsing
const INDIAN_STATES = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
    'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
    'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
    'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
    'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
    'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Delhi', 'New Delhi', 'Chandigarh', 'Puducherry', 'Jammu and Kashmir',
    'Ladakh', 'Lakshadweep', 'Andaman and Nicobar Islands',
];

function parseAddressParts(formattedAddress?: string): { city: string; state: string; address: string } {
    if (!formattedAddress) return { city: '', state: '', address: '' };

    const parts = formattedAddress.split(',').map(p => p.trim());
    let state = '';
    let city = '';

    // Walk from end to find state (skip "India" and postal code)
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i].replace(/\d{6}/, '').trim(); // Remove pincode
        if (part === 'India' || !part) continue;

        const matchedState = INDIAN_STATES.find(s =>
            part.toLowerCase().includes(s.toLowerCase())
        );
        if (matchedState) {
            state = matchedState;
            // City is typically the part before state
            if (i > 0) city = parts[i - 1]?.replace(/\d{6}/, '').trim() || '';
            break;
        }
    }

    // Fallback: second-to-last meaningful part is city
    if (!city && parts.length >= 2) {
        city = parts[parts.length - 2]?.replace(/\d{6}/, '').trim() || '';
    }

    return { city, state, address: formattedAddress };
}

export interface ScrapeResult {
    batchId: string;
    totalResults: number;
    newLeadsCreated: number;
    duplicatesFound: number;
    enrichedExisting: number;
    noPhoneCount: number;
}

export async function processLeadScrape(params: {
    query: string;
    city?: string;
    state?: string;
    userId: string;
}): Promise<ScrapeResult> {
    const { query, city, state, userId } = params;

    // Build search query with city/state
    const textQuery = [query, city, state].filter(Boolean).join(' ');

    // Create batch record
    const batchId = await generateId('SCRAPE', scrapeBatches);
    await db.insert(scrapeBatches).values({
        id: batchId,
        query: textQuery,
        city: city || null,
        state: state || null,
        status: 'processing',
        initiated_by: userId,
    });

    let totalResults = 0;
    let newLeadsCreated = 0;
    let duplicatesFound = 0;
    let enrichedExisting = 0;
    let noPhoneCount = 0;

    try {
        const places = await searchPlaces({ textQuery });
        totalResults = places.length;

        for (const place of places) {
            const result = await processPlace(place, {
                batchId,
                scrapeQuery: textQuery,
                userId,
                fallbackCity: city,
                fallbackState: state,
            });

            switch (result) {
                case 'created': newLeadsCreated++; break;
                case 'duplicate': duplicatesFound++; break;
                case 'enriched': enrichedExisting++; break;
                case 'no_phone': noPhoneCount++; newLeadsCreated++; break; // Still created, but flagged
            }
        }

        // Update batch with final stats
        await db.update(scrapeBatches).set({
            total_results: totalResults,
            new_leads_created: newLeadsCreated,
            duplicates_found: duplicatesFound,
            enriched_existing: enrichedExisting,
            no_phone_count: noPhoneCount,
            status: 'completed',
            completed_at: new Date(),
        }).where(eq(scrapeBatches.id, batchId));

    } catch (error) {
        await db.update(scrapeBatches).set({
            status: 'failed',
            error_message: error instanceof Error ? error.message : 'Unknown error',
            total_results: totalResults,
            completed_at: new Date(),
        }).where(eq(scrapeBatches.id, batchId));
        throw error;
    }

    return { batchId, totalResults, newLeadsCreated, duplicatesFound, enrichedExisting, noPhoneCount };
}

type PlaceProcessResult = 'created' | 'duplicate' | 'enriched' | 'no_phone';

async function processPlace(
    place: PlaceResult,
    ctx: { batchId: string; scrapeQuery: string; userId: string; fallbackCity?: string; fallbackState?: string }
): Promise<PlaceProcessResult> {
    const rawPhone = place.nationalPhoneNumber || place.internationalPhoneNumber || null;
    const normalized = normalizePhone(rawPhone);
    const phoneQuality = classifyPhoneQuality(rawPhone);
    const placeId = place.id;
    const { city, state, address } = parseAddressParts(place.formattedAddress);

    // Dedup: check by google_place_id or normalized_phone
    const conditions = [];
    if (placeId) conditions.push(eq(leads.google_place_id, placeId));
    if (normalized) conditions.push(eq(leads.normalized_phone, normalized));

    if (conditions.length > 0) {
        const [existing] = await db.select({ id: leads.id })
            .from(leads)
            .where(conditions.length === 1 ? conditions[0] : or(...conditions))
            .limit(1);

        if (existing) {
            // Enrich: update Google-specific fields on existing lead
            await db.update(leads).set({
                google_place_id: placeId || undefined,
                website: place.websiteUri || undefined,
                google_maps_uri: place.googleMapsUri || undefined,
                google_rating: place.rating?.toString() || undefined,
                google_ratings_count: place.userRatingCount || undefined,
                google_business_status: place.businessStatus || undefined,
                google_business_types: place.types || undefined,
                updated_at: new Date(),
            }).where(eq(leads.id, existing.id));

            return normalized ? 'enriched' : 'duplicate';
        }
    }

    // New lead
    const businessName = place.displayName?.text || 'Unknown Business';
    const leadId = await generateId('LEAD', leads);
    const now = new Date();

    const isNoPhone = phoneQuality === 'missing';

    await db.insert(leads).values({
        id: leadId,
        lead_source: 'google_maps',
        lead_status: 'new',
        interest_level: 'cold',

        owner_name: businessName,
        owner_contact: normalized || 'N/A',
        business_name: businessName,
        phone: normalized,

        city: city || ctx.fallbackCity || null,
        state: state || ctx.fallbackState || null,
        shop_address: address || null,

        // Google Maps fields
        google_place_id: placeId,
        website: place.websiteUri || null,
        google_maps_uri: place.googleMapsUri || null,
        google_rating: place.rating?.toString() || null,
        google_ratings_count: place.userRatingCount || null,
        google_business_status: place.businessStatus || null,
        google_business_types: place.types || null,
        raw_source_payload: place as unknown as Record<string, unknown>,
        scrape_query: ctx.scrapeQuery,
        scrape_batch_id: ctx.batchId,
        scraped_at: now,

        // Phone quality
        phone_quality: phoneQuality,
        normalized_phone: normalized,
        do_not_call: phoneQuality !== 'valid',

        // Defaults
        lead_score: 30, // cold
        status: 'ACTIVE',
        workflow_step: 1,
        uploader_id: ctx.userId,
        created_at: now,
        updated_at: now,
    });

    return isNoPhone ? 'no_phone' : 'created';
}
