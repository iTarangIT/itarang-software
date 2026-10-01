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

/**
 * Origins that mean nothing without the campaign: WHICH trade event, WHICH ad.
 * A lead with one of these cannot be created without a campaign.
 */
export const CAMPAIGN_REQUIRED_ORIGINS: readonly LeadOrigin[] = ["trade_event", "digital_ad"];

export function campaignRequired(origin: string | null | undefined): boolean {
    return (CAMPAIGN_REQUIRED_ORIGINS as readonly string[]).includes(origin ?? "");
}

export const CAMPAIGN_REQUIRED_MESSAGE = "Pick the campaign — a Trade event or Digital ad lead needs one.";

/**
 * Found via for a lead that arrives on a calling list with nobody to ask —
 * NeoDove-born leads, and an AI-dialer list uploaded without a choice. The
 * E-319 trigger and the E-320 backfill write the same value.
 */
export const LIST_DEFAULT_ORIGIN: LeadOrigin = "purchased_list";

/** How an acquisition campaign came to exist (acquisition_campaigns.kind, E-319). */
export const CAMPAIGN_KINDS = ["manual", "upload_batch", "scrape_run", "dialer_list"] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

export const CAMPAIGN_KIND_LABEL: Record<CampaignKind, string> = {
    manual: "Named by a person",
    upload_batch: "Bulk upload",
    scrape_run: "Scrape run",
    dialer_list: "AI-dialer list",
};

const day = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/**
 * Names for the campaigns the system makes itself. Each ends in a piece of the
 * batch / run id, so two uploads of the same file on one day stay apart
 * (campaign names are unique).
 */
export function uploadCampaignName(p: { label: string | null; fileName: string; at: Date; batchId: string }): string {
    return `Upload · ${p.label?.trim() || p.fileName} · ${day(p.at)} · ${p.batchId.slice(0, 8)}`;
}

export function scrapeCampaignName(p: { query: string | null; at: Date; runId: string }): string {
    return `Scrape · ${(p.query?.trim() || "run").slice(0, 80)} · ${day(p.at)} · ${p.runId.slice(-8)}`;
}

export function listCampaignName(listName: string): string {
    return `List · ${listName.trim()}`;
}

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
