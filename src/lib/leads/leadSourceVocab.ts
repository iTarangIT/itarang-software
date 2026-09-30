// Lead source vocabulary (tracker ID 81) — CLIENT-SAFE, no db import. The
// writers live in leadSource.ts.
//
// Three tags on every lead, named on screen as:
//   Entered via  (door)      how the lead got into the CRM — set by the code path
//   Found via    (origin)    how we found the dealer — the rep picks, fixed list
//   Campaign                 the specific event / list / batch
// "Door" and "origin" are spec words; reps only ever see the labels below.

export const SOURCE_LABELS = {
    door: "Entered via",
    origin: "Found via",
    campaign: "Campaign",
} as const;

export const LEAD_DOORS = [
    "scraper",
    "bulk_upload",
    "rep_create",
    "whatsapp_assistant",
    "ai_dialer",
    "neodove",
    "ecofy",
] as const;
export type LeadDoor = (typeof LEAD_DOORS)[number];

export const LEAD_DOOR_LABEL: Record<LeadDoor, string> = {
    scraper: "Scraper",
    bulk_upload: "Bulk upload",
    rep_create: "Rep-created",
    whatsapp_assistant: "WhatsApp Assistant",
    ai_dialer: "AI-dialer list",
    neodove: "NeoDove",
    ecofy: "Ecofy",
};

export const LEAD_ORIGINS = [
    "field_walk_in",
    "trade_event",
    "dealer_referral",
    "oem_referral",
    "inbound_call",
    "scraped_listing",
    "purchased_list",
    "digital_ad",
] as const;
export type LeadOrigin = (typeof LEAD_ORIGINS)[number];

export const LEAD_ORIGIN_LABEL: Record<LeadOrigin, string> = {
    field_walk_in: "Field walk-in",
    trade_event: "Trade event",
    dealer_referral: "Dealer referral",
    oem_referral: "OEM referral",
    inbound_call: "Inbound call",
    scraped_listing: "Scraped listing",
    purchased_list: "Purchased list",
    digital_ad: "Digital ad",
};

/** Label for a stored door; older rows may hold a value outside the list. */
export function doorLabel(v: string | null | undefined): string | null {
    if (!v) return null;
    return LEAD_DOOR_LABEL[v as LeadDoor] ?? v.replace(/_/g, " ");
}

/** Label for a stored origin; older rows may hold a value outside the list. */
export function originLabel(v: string | null | undefined): string | null {
    if (!v) return null;
    return LEAD_ORIGIN_LABEL[v as LeadOrigin] ?? v.replace(/_/g, " ");
}
