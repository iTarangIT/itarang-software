// Lead source vocabulary (tracker ID 81) — CLIENT-SAFE, no db import. The
// writers live in leadSource.ts.

export const LEAD_DOORS = [
    "rep_create",
    "bulk_upload",
    "scraper",
    "neodove",
    "whatsapp_assistant",
    "whatsapp_inbound",
    "ai_dialer",
    "api",
    "dealer_referral",
    "admin",
] as const;
export type LeadDoor = (typeof LEAD_DOORS)[number];

export const LEAD_ORIGINS = [
    "field_visit",
    "cold_call_list",
    "google_maps_scrape",
    "indiamart_scrape",
    "referral_dealer",
    "referral_oem",
    "trade_show",
    "inbound_call",
    "whatsapp_inbound",
    "website",
    "social_media",
    "other",
] as const;
export type LeadOrigin = (typeof LEAD_ORIGINS)[number];

export const LEAD_ORIGIN_LABEL: Record<LeadOrigin, string> = {
    field_visit: "Field visit",
    cold_call_list: "Cold-call list",
    google_maps_scrape: "Google Maps scrape",
    indiamart_scrape: "IndiaMART scrape",
    referral_dealer: "Referral — dealer",
    referral_oem: "Referral — OEM",
    trade_show: "Trade show",
    inbound_call: "Inbound call",
    whatsapp_inbound: "WhatsApp inbound",
    website: "Website",
    social_media: "Social media",
    other: "Other",
};

