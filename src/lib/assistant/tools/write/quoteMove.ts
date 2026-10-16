// What a quote event will do to the lead — for the create_quote / send_quote
// cards. Pure, and the same decision advanceLeadOnQuoteEvent
// (lib/leads/quoteStatus.ts) makes after the quote is saved / delivered, so the
// card's Status line and idle-clock footer are what the writer then does:
//
//   lead Awaiting field visit   status stays (only a visit ends it, ID 77); the
//                               pre-transfer stage is raised instead — no
//                               status touchpoint, so the idle clock does not move
//   forward move                status_change_note with the move — work, resets
//                               the idle clock (isWorkedTouchpoint)
//   otherwise                   nothing moves
//
// The move runs after COMMIT, best-effort: the S3 guard can still refuse it
// there, in which case the lead stays where it was.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isForward } from "@/lib/lifecycle/statusRules";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { statusLabel } from "../../format";

export type QuoteCardEvent = "created" | "delivered";

const TARGET: Record<QuoteCardEvent, LeadStatus> = {
    created: "Commercials_Explained",
    delivered: "Awaiting_Customer_Decision",
};

export type QuoteMovePreview = {
    /** The card's Status line value. */
    status: string;
    /** Does the event write a status touchpoint (= resets the idle clock)? */
    resetsIdleClock: boolean;
};

/** The pre-transfer stage, read only for a lead Awaiting field visit (else null, no query). */
export async function preTransferStatusFor(leadId: string, leadStatus: string | null): Promise<string | null> {
    if (leadStatus !== "Transferred_to_ASM") return null;
    const rows = (await db.execute<{ pre_transfer_status: string | null }>(sql`
        SELECT pre_transfer_status FROM dealer_leads WHERE id = ${leadId} LIMIT 1
    `)) as unknown as Array<{ pre_transfer_status: string | null }>;
    return rows[0]?.pre_transfer_status ?? null;
}

export function quoteMovePreview(input: {
    event: QuoteCardEvent;
    leadStatus: string | null;
    /** dealer_leads.pre_transfer_status — read only for a lead Awaiting field visit. */
    preTransferStatus?: string | null;
}): QuoteMovePreview {
    const target = TARGET[input.event];
    if (input.leadStatus === "Transferred_to_ASM") {
        const raised = isForward(input.preTransferStatus ?? null, target);
        return {
            status:
                `${statusLabel(input.leadStatus)} (unchanged until the visit` +
                (raised ? `; the visit then restores ${statusLabel(target)})` : ")"),
            resetsIdleClock: false,
        };
    }
    if (!isForward(input.leadStatus, target)) return { status: "no change", resetsIdleClock: false };
    return {
        status: `${statusLabel(input.leadStatus)} → ${statusLabel(target)}`,
        resetsIdleClock: isWorkedTouchpoint("status_change_note", true, "progress"),
    };
}
