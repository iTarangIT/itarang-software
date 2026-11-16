// ID 235: the NeoDove campaign line on the lead page and the Reassign move
// rule. Pure (no I/O) so the client can import it; the reads live in
// ./leadCampaign.ts.

export type LeadNeodoveCampaign = {
    campaign_id: string;
    /** The CRM's name for the campaign. */
    name: string;
    /** Its name inside NeoDove, when recorded. */
    neodove_name: string | null;
    /** pending | pushed | failed | skipped_dedup | skipped_excluded */
    push_status: string;
    pushed_at: string | null;
    push_error: string | null;
};

export type OwnerCampaign = { campaign_id: string; name: string; neodove_name: string | null };

/** True when the lead is actually in that campaign (a refused push is not). */
export function isInCampaign(c: Pick<LeadNeodoveCampaign, "push_status"> | null): boolean {
    return !!c && (c.push_status === "pushed" || c.push_status === "pending");
}

/** The lead-page line, in words. */
export function neodoveCampaignLine(c: LeadNeodoveCampaign | null, fmtDate: (iso: string) => string): string {
    if (!c) return "Not sent to NeoDove";
    const name = c.neodove_name ? `${c.name} (${c.neodove_name} in NeoDove)` : c.name;
    if (c.push_status === "pushed") return `${name}, sent ${c.pushed_at ? fmtDate(c.pushed_at) : "(date not recorded)"}`;
    if (c.push_status === "pending") return `${name}, waiting to be sent`;
    if (c.push_status === "skipped_dedup") return `${name}, not sent: already in NeoDove`;
    if (c.push_status === "skipped_excluded") return `${name}, not sent: being worked in the CRM`;
    return `${name}, not sent: refused${c.push_error ? ` (${c.push_error.slice(0, 120)})` : ""}`;
}

export type MovePreview = {
    current: LeadNeodoveCampaign | null;
    target: OwnerCampaign | null;
    /** Offer 'Also move': the lead is in a campaign and the new owner has a different one. */
    offer: boolean;
};

export function movePreview(current: LeadNeodoveCampaign | null, target: OwnerCampaign | null): MovePreview {
    return {
        current,
        target,
        offer: isInCampaign(current) && !!target && target.campaign_id !== current!.campaign_id,
    };
}
