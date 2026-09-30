// Withdraw quote (tracker ID 78, handover P2-6, 29 Sep 2026).
//
// The owner or a manager closes a stale quote with a reason: withdrawn_at /
// withdrawn_by / withdraw_reason are written (E-314), the dealer's link stops
// accepting an answer (recordDealerDecision refuses a withdrawn version and
// the page says "withdrawn"), and a lead at a commercials stage goes back to
// Under discussion — no status dropdown needed. There is no automatic expiry.
//
// A lead awaiting a field visit keeps that status; its pre_transfer_status is
// lowered instead, so the visit does not restore a stage the quote no longer
// supports.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

export class WithdrawQuoteError extends Error {
    readonly status: number;
    constructor(message: string, status = 409) {
        super(message);
        this.status = status;
    }
}

const COMMERCIALS = new Set(["Commercials_Explained", "Awaiting_Customer_Decision", "Commercials_Finalised"]);

type Row = {
    event_type: string;
    quote_number: string | null;
    withdrawn_at: string | null;
    lead_status: string | null;
    pre_transfer_status: string | null;
};

export async function withdrawQuote(input: {
    leadId: string;
    commercialId: string;
    actorId: string;
    reason: string;
}): Promise<{ quoteNumber: string | null; leadStatus: string | null }> {
    return db.transaction(async (tx) => {
        const rows = (await tx.execute<Row>(sql`
            SELECT c.event_type, c.quote_number, c.withdrawn_at::text AS withdrawn_at,
                   dl.lead_status, dl.pre_transfer_status
              FROM dealer_lead_commercials c
              JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
             WHERE c.commercial_id = ${input.commercialId}::uuid
               AND c.dealer_lead_id = ${input.leadId}
             FOR UPDATE OF c
        `)) as unknown as Row[];
        const q = rows[0];
        if (!q) throw new WithdrawQuoteError("Quote not found.", 404);
        if (!["quote_issue", "quote_revision"].includes(q.event_type)) {
            throw new WithdrawQuoteError("Only a quote can be withdrawn.", 400);
        }
        if (q.withdrawn_at) throw new WithdrawQuoteError("This quote is already withdrawn.");
        if (q.lead_status === "Won" || q.lead_status === "Converted" || q.lead_status === "Lost") {
            throw new WithdrawQuoteError(`The lead is ${q.lead_status}; its quote cannot be withdrawn.`);
        }

        await tx.execute(sql`
            UPDATE dealer_lead_commercials
               SET withdrawn_at = NOW(), withdrawn_by = ${input.actorId},
                   withdraw_reason = ${input.reason}, updated_at = NOW()
             WHERE commercial_id = ${input.commercialId}::uuid
        `);

        const remark = `Quote${q.quote_number ? ` ${q.quote_number}` : ""} withdrawn — ${input.reason}`;
        let leadStatus = q.lead_status;
        if (q.lead_status && COMMERCIALS.has(q.lead_status)) {
            await writeTouchpoint(
                {
                    dealerLeadId: input.leadId,
                    touchpointType: "status_change_note",
                    performedBy: input.actorId,
                    remarks: remark,
                    statusChange: {
                        from: q.lead_status as LeadStatus,
                        to: "Under_Discussion",
                        reasonNotes: input.reason,
                        event: "quote_withdrawn",
                    },
                },
                { tx },
            );
            leadStatus = "Under_Discussion";
        } else {
            if (
                q.lead_status === "Transferred_to_ASM" &&
                q.pre_transfer_status &&
                COMMERCIALS.has(q.pre_transfer_status)
            ) {
                await tx.execute(sql`
                    UPDATE dealer_leads SET pre_transfer_status = 'Under_Discussion' WHERE id = ${input.leadId}
                `);
            }
            await writeTouchpoint(
                {
                    dealerLeadId: input.leadId,
                    touchpointType: "status_change_note",
                    performedBy: input.actorId,
                    remarks: remark,
                },
                { tx },
            );
        }
        return { quoteNumber: q.quote_number, leadStatus };
    });
}
