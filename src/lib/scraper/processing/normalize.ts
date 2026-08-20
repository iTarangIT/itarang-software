import { normalizeIndianPhone } from "@/lib/ai/phone";
import { detectForeignCountry } from "../geo";
import {
  parseAddressComponents,
  extractTargetCityFromQuery,
} from "@/lib/scraper-enrichment";

// Convert each raw lead from a scraping source into the canonical shape used
// downstream by saveCleanLeads / promoteLeadsToDealerLeads.
//
// When the raw lead carries Google Places `addressComponents` (set on
// PlaceResult by src/lib/scraper/query/sources/googlePlaces.ts), we pass
// them straight through — leadStore.normalizeRegion() prefers structured
// components over regex parsing. For sources without components (Apify),
// or rare Places rows where Google omitted addressComponents, we still
// run parseAddressComponents() here as a hint; normalizeRegion() will
// re-parse internally too, but pre-extracting lets us populate the
// scraped_dealer_leads.location_city column even before promotion.
//
// The first comma segment of formattedAddress is almost always a street
// fragment ("Shop No. 40", "954"); parseAddressComponents walks from the
// END (anchored on the PIN) to pull the real city + state. As a last
// resort we fall back to the chunk's target city embedded in
// lead.source_query ("battery dealer in Mysuru" -> "Mysuru"), which is
// always present because chunkedPipeline tags every raw lead.
export function normalizeLeads(leads: any[], source: string) {
  return leads.map((lead) => {
    const components = lead.components ?? undefined;
    const parsed = parseAddressComponents(lead.address);
    const fallbackCity = parsed.city
      ? undefined
      : extractTargetCityFromQuery(lead.source_query);
    // City/state shown here are best-effort hints for the
    // scraped_dealer_leads table. The authoritative normalization runs at
    // promote time through src/lib/locations/normalize.ts.
    const city =
      components?.city ?? parsed.city ?? fallbackCity ?? null;
    const state = components?.state ?? parsed.state ?? null;
    const pincode = components?.pincode ?? parsed.pincode ?? null;

    // normalizeIndianPhone prefixes "+91" to ANY 10-digit string, so a US
    // number arrives looking like a valid Indian mobile — (954) 527-4640
    // became +919545274640 on run SCRAPE-20260820-e3ae054b and was dialled as
    // such. filterLeads drops foreign leads outright, but never let a foreign
    // number acquire an Indian country code on the way there.
    const foreignCountry = detectForeignCountry({
      address: lead.address,
      components,
    });

    return {
      name: lead.name || null,
      phone: foreignCountry ? null : normalizeIndianPhone(lead.phone),
      email: null,
      website: lead.website || null,

      city,
      state,
      pincode,
      address: lead.address || null,
      // Forward structured components untouched; promote-time normalization
      // prefers these over regex parsing.
      components,

      source,
      status: "New",
    };
  });
}
