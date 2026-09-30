// Commercials stages move ONLY on quote events (tracker ID 75, handover
// P2-2 / P2-4, 29 Sep 2026) — the one writer for web and WhatsApp alike:
//
//   quote created (issue / revision)  → Commercials_Explained
//   quote delivered to the dealer     → Awaiting_Customer_Decision
//   dealer approved the quote         → Commercials_Finalised (+ prompt Mark Won)
//   quote withdrawn                   → Under_Discussion (ID 78, correction event)
//
// Forward only (S3). A lead Awaiting field visit (Transferred_to_ASM) keeps that
// status — only a visit ends it (ID 77) — but its pre_transfer_status is raised,
// so the visit restores the later stage. Best-effort: a quote event must never
// fail because the lead could not move; the reason is logged.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { isForward, rankOf } from "@/lib/lifecycle/statusRules";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

export type QuoteStatusEvent = "created" | "delivered" | "dealer_approved";

const TARGET: Record<QuoteStatusEvent, LeadStatus> = {
    created: "Commercials_Explained",
    delivered: "Awaiting_Customer_Decision",
    dealer_approved: "Commercials_Finalised",
};

const REMARK: Record<QuoteStatusEvent, string> = {
    created: "Quote created — Commercials explained.",
    delivered: "Quote delivered to the dealer — awaiting their decision.",
    dealer_approved: "Dealer approved the quote — Commercials finalised. Next: Mark Won.",
};

export async function advanceLeadOnQuoteEvent(
    leadId: string,
    event: QuoteStatusEvent,
    actorId: string | null,
): Promise<{ moved: boolean; status: string | null }> {
    const target = TARGET[event];
    try {
        const rows = (await db.execute<{ lead_status: string | null; pre_transfer_status: string | null }>(sql`
            SELECT lead_status, pre_transfer_status FROM dealer_leads WHERE id = ${leadId} LIMIT 1
        `)) as unknown as Array<{ lead_status: string | null; pre_transfer_status: string | null }>;
        const lead = rows[0];
        if (!lead) return { moved: false, status: null };

        if (lead.lead_status === "Transferred_to_ASM") {
            const pre = rankOf(lead.pre_transfer_status);
            if (pre !== null && isForward(lead.pre_transfer_status, target)) {
                await db.execute(sql`
                    UPDATE dealer_leads SET pre_transfer_status = ${target}, updated_at = NOW()
                     WHERE id = ${leadId} AND lead_status = 'Transferred_to_ASM'
                `);
            }
            return { moved: false, status: lead.lead_status };
        }
        if (!isForward(lead.lead_status, target)) return { moved: false, status: lead.lead_status };

        await writeTouchpoint({
            dealerLeadId: leadId,
            touchpointType: "status_change_note",
            performedBy: actorId,
            remarks: REMARK[event],
            statusChange: { from: lead.lead_status as LeadStatus | null, to: target, event: "progress" },
        });
        return { moved: true, status: target };
    } catch (err) {
        console.error(`[quoteStatus] ${leadId} ${event} → ${target} not applied:`, err instanceof Error ? err.message : err);
        return { moved: false, status: null };
    }
}
