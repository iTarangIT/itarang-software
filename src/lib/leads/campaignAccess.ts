// Who may add or change an acquisition campaign (tracker ID 81). CLIENT-SAFE —
// no db import. Everyone who can create a lead can PICK a campaign; only these
// roles can add one, so the register stays one row per event.

export const CAMPAIGN_MANAGE_ROLES = ["admin", "ceo", "business_head", "sales_head", "sales_manager", "partner"] as const;

export function canManageCampaigns(role: string | null | undefined): boolean {
    return (CAMPAIGN_MANAGE_ROLES as readonly string[]).includes((role ?? "").toLowerCase());
}
