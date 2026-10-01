// A lead's city / state / legacy `location`, canonicalised the way every lead
// writer does it (create route, bulk wizard, NeoDove inbound). Extracted from
// PATCH /api/dealer-leads/[id] so the WhatsApp Assistant's update_lead writes
// exactly what the edit form would.
//
//   · city / state go through the scraper-enrichment normalisers; a missing
//     state is inferred from the city.
//   · `location` is the legacy free-form region the lead page still renders
//     (`location || city`): set when given, else backfilled from the city ONLY
//     when it is empty — an existing value may hold a fuller address.

import { inferStateFromCity, normalizeCity, normalizeState } from "@/lib/scraper-enrichment";

export type RegionInput = { city?: string; state?: string; location?: string };

export function canonicalRegionUpdates(
    body: RegionInput,
    existingLocation: string | null,
): { city?: string | null; state?: string | null; location?: string | null } {
    if (body.city === undefined && body.state === undefined && body.location === undefined) return {};
    const canonicalCity = normalizeCity(body.city || body.location || undefined) ?? null;
    const canonicalState = normalizeState(body.state || undefined) ?? inferStateFromCity(canonicalCity) ?? null;
    const out: { city?: string | null; state?: string | null; location?: string | null } = {};
    if (body.city !== undefined) out.city = canonicalCity;
    if (body.state !== undefined) out.state = canonicalState;
    if (body.location !== undefined) {
        out.location = body.location || canonicalCity;
    } else if (!existingLocation && canonicalCity) {
        out.location = canonicalCity;
    }
    return out;
}
