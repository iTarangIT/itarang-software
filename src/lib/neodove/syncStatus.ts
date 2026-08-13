// What `dealer_leads.neodove_sync_status` means, in one place (E-224/E-226/E-237).
//
// WHY THIS IS NOT `source = 'neodove'`. `dealer_leads.source` records where a
// lead CAME FROM, and inbound.ts only sets it to "neodove" for leads NeoDove
// itself created. A lead we scraped and then handed to a NeoDove campaign keeps
// source = 'scraper' forever — which is correct, and also exactly the lead the
// operator is asking about when they say "show me the NeoDove ones". The
// question the badge and the filter answer is "is this lead with the calling
// team", and the column that answers it is neodove_sync_status.
//
// PURE — no drizzle, no db imports. Both a client component (the row chip) and
// two SQL builders read these, and pulling drizzle-orm into the client bundle
// to share one array would be a bad trade.

/**
 * The states in which a lead demonstrably exists in NeoDove.
 *
 * `failed` is deliberately absent: that push was refused, so the lead is NOT
 * with the calling team and must stay re-sendable — the same cut
 * SendToNeodoveButton makes when deciding whether to say "Sent".
 *
 * `inbound` counts because the lead came back FROM NeoDove, and `priority_dial`
 * (E-226) because it is a push with an extra flag, not a different destination.
 */
export const NEODOVE_LINKED_SYNC_STATUSES = [
    "pushed",
    "inbound",
    "priority_dial",
] as const;

export type NeodoveLinkedStatus = (typeof NEODOVE_LINKED_SYNC_STATUSES)[number];

export function isNeodoveLinked(
    status: string | null | undefined,
): status is NeodoveLinkedStatus {
    return (
        !!status &&
        (NEODOVE_LINKED_SYNC_STATUSES as readonly string[]).includes(status)
    );
}

/** Hover text for the row chip — the four states read very differently. */
export function neodoveTagTitle(status: string | null | undefined): string {
    switch (status) {
        case "priority_dial":
            return "Sent to NeoDove for priority dialling";
        case "inbound":
            return "Created from a NeoDove call — this lead came from the calling team";
        case "pushed":
        default:
            return "Handed to the NeoDove calling team";
    }
}
