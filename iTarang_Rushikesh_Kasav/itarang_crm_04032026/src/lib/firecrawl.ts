/**
 * Firecrawl integration for Dealer Lead Scraper.
 *
 * Env var required: FIRECRAWL_API_KEY
 *
 * Uses Firecrawl v4's /search endpoint to discover dealer listing pages, then
 * returns normalised RawDealerRecord objects ready for deduplication.
 */

import FirecrawlApp from '@mendable/firecrawl-js';
import { z } from 'zod';
import type { RawDealerRecord } from '@/types/scraper';

// ---------------------------------------------------------------------------
// Client (lazy singleton so tests can override process.env first)
// ---------------------------------------------------------------------------
let _client: FirecrawlApp | null = null;

function getClient(): FirecrawlApp {
    if (!_client) {
        const apiKey = process.env.FIRECRAWL_API_KEY;
        if (!apiKey) {
            throw new Error(
                'FIRECRAWL_API_KEY is not set. Add it to your .env.local file.'
            );
        }
        _client = new FirecrawlApp({ apiKey });
    }
    return _client;
}

// ---------------------------------------------------------------------------
// Zod schema — used with Firecrawl's JSON extraction format
// ---------------------------------------------------------------------------
const DealerExtractSchema = z.object({
    dealers: z.array(
        z.object({
            dealer_name: z.string().describe('Name of the dealer or business'),
            phone: z.string().optional().describe('Primary contact phone number'),
            city: z.string().optional().describe('City where the dealer is located'),
            state: z.string().optional().describe('State/region where the dealer is located'),
            address: z.string().optional().describe('Full address if available'),
            email: z.string().optional().describe('Email address if available'),
            gst_number: z.string().optional().describe('GST number / GSTIN if available'),
            business_type: z.string().optional().describe('Type: distributor, dealer, wholesaler, or retailer'),
            products_sold: z.string().optional().describe('Products or brands they sell'),
            website: z.string().optional().describe('Website URL if available'),
        })
    ).describe('List of 3-wheeler battery dealers found on the page'),
});

// ---------------------------------------------------------------------------
// Search queries targeting B2B listing sites
// ---------------------------------------------------------------------------
export const DEALER_SEARCH_QUERIES: string[] = [
    '3 wheeler electric battery dealer wholesale India',
    'e-rickshaw battery distributor dealer India',
    'electric rickshaw battery supplier dealer list India',
    '3W EV battery dealer contact phone number India',
    'lithium battery 3 wheeler dealer India directory',
];

// ---------------------------------------------------------------------------
// Phone normalisation helper
// ---------------------------------------------------------------------------
export function normalizePhone(raw: string | undefined | null): string | null {
    if (!raw) return null;
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
    if (digits.length > 10) return `+91${digits.slice(-10)}`;
    return null;
}

// ---------------------------------------------------------------------------
// Known directory domains for deep scraping
// ---------------------------------------------------------------------------
const DIRECTORY_DOMAINS = [
    'justdial.com',
    'indiamart.com',
    'dir.indiamart.com',
    'sulekha.com',
    'tradeindia.com',
    'exportersindia.com',
    'getdistributors.com',
    'google.com/maps',
    'google.co.in/maps',
];

function isDirectoryUrl(url: string): boolean {
    try {
        const hostname = new URL(url).hostname.replace('www.', '');
        const fullUrl = url.toLowerCase();
        return DIRECTORY_DOMAINS.some(
            (domain) => hostname.includes(domain) || fullUrl.includes(domain)
        );
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Deep scrape a single directory page for dealer records
// ---------------------------------------------------------------------------
export async function scrapeDirectoryPage(url: string): Promise<RawDealerRecord[]> {
    const app = getClient();
    const results: RawDealerRecord[] = [];

    try {
        const scrapeResponse = await app.scrapeUrl(url, {
            formats: [
                {
                    type: 'json',
                    schema: DealerExtractSchema,
                    prompt:
                        'This is a business directory or listing page. Extract EVERY dealer, ' +
                        'distributor, wholesaler, or supplier listed on this page. For each, ' +
                        'extract: business name, phone number, city, state, email, GST number, ' +
                        'business type (dealer/distributor/wholesaler/retailer), products they sell, ' +
                        'and website. Extract ALL listings, not just the first few.',
                } as { type: 'json'; schema: typeof DealerExtractSchema; prompt: string },
            ],
        });

        const parsed = DealerExtractSchema.safeParse(
            (scrapeResponse as { json?: unknown }).json
        );
        if (!parsed.success || !parsed.data.dealers?.length) return results;

        for (const d of parsed.data.dealers) {
            if (!d.dealer_name) continue;
            results.push({
                dealer_name: d.dealer_name.trim(),
                phone: normalizePhone(d.phone) ?? undefined,
                city: d.city?.trim(),
                state: d.state?.trim(),
                address: d.address?.trim(),
                source_url: url,
                email: d.email?.trim(),
                gst_number: d.gst_number?.trim(),
                business_type: d.business_type?.trim()?.toLowerCase(),
                products_sold: d.products_sold?.trim(),
                website: d.website?.trim(),
            });
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Firecrawl] Error scraping directory page "${url}":`, msg);
    }

    return results;
}

// ---------------------------------------------------------------------------
// Phase 1: Search — discover relevant URLs (search is discovery, not extraction)
// Returns { records (if JSON extraction worked), discoveredUrls (all result URLs) }
// ---------------------------------------------------------------------------

interface SearchResult {
    records: RawDealerRecord[];
    discoveredUrls: string[];
}

export async function searchDealers(query: string): Promise<SearchResult> {
    const app = getClient();
    const records: RawDealerRecord[] = [];
    const discoveredUrls: string[] = [];

    try {
        const searchResponse = await app.search(query, {
            limit: 8,
            scrapeOptions: {
                formats: [
                    {
                        type: 'json',
                        schema: DealerExtractSchema,
                        prompt:
                            'Extract every 3-wheeler battery dealer from this page. ' +
                            'Include dealer name, phone number, city, state, email, GST number, ' +
                            'business type, products sold, and website. Only extract dealers.',
                    } as { type: 'json'; schema: typeof DealerExtractSchema; prompt: string },
                ],
            },
        });

        const webResults = (searchResponse as { web?: unknown[] }).web ?? [];

        for (const item of webResults) {
            const doc = item as { url?: string; json?: unknown };
            const pageUrl = doc.url ?? '';

            // Always collect the URL for potential Phase 2 scraping
            if (pageUrl) {
                discoveredUrls.push(pageUrl);
            }

            // If JSON extraction worked, great — use it
            if (doc.json) {
                const parsed = DealerExtractSchema.safeParse(doc.json);
                if (parsed.success && parsed.data.dealers?.length) {
                    for (const d of parsed.data.dealers) {
                        if (!d.dealer_name) continue;
                        records.push({
                            dealer_name: d.dealer_name.trim(),
                            phone: normalizePhone(d.phone) ?? undefined,
                            city: d.city?.trim(),
                            state: d.state?.trim(),
                            address: d.address?.trim(),
                            source_url: pageUrl,
                            email: d.email?.trim(),
                            gst_number: d.gst_number?.trim(),
                            business_type: d.business_type?.trim()?.toLowerCase(),
                            products_sold: d.products_sold?.trim(),
                            website: d.website?.trim(),
                        });
                    }
                }
            }
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Firecrawl] Error searching "${query}":`, msg);
    }

    return { records, discoveredUrls };
}

// ---------------------------------------------------------------------------
// Helper: deduplicate and add record to the collection
// ---------------------------------------------------------------------------
function addRecordIfNew(
    record: RawDealerRecord,
    allRecords: RawDealerRecord[],
    seenPhones: Set<string>,
    seenUrls: Set<string>,
): boolean {
    const phoneKey = record.phone;
    const urlKey = record.source_url ? record.source_url.split('?')[0] : null;

    if (phoneKey && seenPhones.has(phoneKey)) return false;
    if (urlKey && seenUrls.has(urlKey)) return false;

    if (phoneKey) seenPhones.add(phoneKey);
    if (urlKey) seenUrls.add(urlKey);

    allRecords.push(record);
    return true;
}

// ---------------------------------------------------------------------------
// Run all search queries with two-phase approach:
//   Phase 1: Search (discovery) — collect URLs + any inline JSON results
//   Phase 2: Scrape (extraction) — deep scrape discovered pages for dealers
// ---------------------------------------------------------------------------
export async function scrapeAllDealers(customQueries?: string[]): Promise<{
    records: RawDealerRecord[];
    queriesUsed: string[];
}> {
    const queries = customQueries ?? DEALER_SEARCH_QUERIES;
    const allRecords: RawDealerRecord[] = [];
    const seenPhones = new Set<string>();
    const seenUrls = new Set<string>();
    const urlsToScrape = new Set<string>();
    const scrapedPageUrls = new Set<string>();

    // Phase 1: Search — discover URLs and collect any inline extractions
    console.log(`[Firecrawl] Phase 1: Running ${queries.length} search queries...`);

    for (const query of queries) {
        const { records, discoveredUrls } = await searchDealers(query);

        // Add any inline extracted records
        for (const record of records) {
            addRecordIfNew(record, allRecords, seenPhones, seenUrls);
        }

        // Collect ALL discovered URLs for Phase 2 scraping
        for (const url of discoveredUrls) {
            const normalized = url.split('?')[0].toLowerCase();
            if (!scrapedPageUrls.has(normalized)) {
                urlsToScrape.add(url);
            }
        }
    }

    console.log(
        `[Firecrawl] Phase 1 results: ${allRecords.length} records from inline extraction, ` +
        `${urlsToScrape.size} URLs discovered for deep scraping`
    );

    // Phase 2: Scrape — deep extract from discovered pages
    // Prioritize directory pages, then scrape others if budget allows
    const directoryUrls: string[] = [];
    const otherUrls: string[] = [];

    for (const url of urlsToScrape) {
        if (isDirectoryUrl(url)) {
            directoryUrls.push(url);
        } else {
            otherUrls.push(url);
        }
    }

    // Scrape up to 8 directory pages + up to 4 non-directory pages
    const pagesToScrape = [
        ...directoryUrls.slice(0, 8),
        ...otherUrls.slice(0, 4),
    ];

    console.log(
        `[Firecrawl] Phase 2: Scraping ${pagesToScrape.length} pages ` +
        `(${Math.min(directoryUrls.length, 8)} directories, ` +
        `${Math.min(otherUrls.length, 4)} other)...`
    );

    for (const url of pagesToScrape) {
        const normalized = url.split('?')[0].toLowerCase();
        if (scrapedPageUrls.has(normalized)) continue;
        scrapedPageUrls.add(normalized);

        const deepResults = await scrapeDirectoryPage(url);
        let added = 0;
        for (const record of deepResults) {
            if (addRecordIfNew(record, allRecords, seenPhones, seenUrls)) {
                added++;
            }
        }
        console.log(`[Firecrawl]   ${url.slice(0, 80)}... → ${deepResults.length} found, ${added} new`);
    }

    console.log(`[Firecrawl] Total: ${allRecords.length} unique records from ${queries.length} queries`);

    return { records: allRecords, queriesUsed: queries };
}
