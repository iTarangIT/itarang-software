// Withdraw quote (tracker ID 78, handover P2-6, 29 Sep 2026).
//
// The owner or a manager closes a stale quote with a reason: withdrawn_at /
// withdrawn_by / withdraw_reason are written (E-314), the dealer's link stops
// accepting an answer (recordDealerDecision refuses a withdrawn version and
// the page says "withdrawn"), and a lead at a commercials stage goes back to
// Under discussion — no status dropdown needed. There is no automatic expiry.
//
// WHICH VERSION is withdrawn decides what happens to the lead (review 30 Sep):
//
//   - The lead goes back ONLY when no quote is left in play — no other version
//     that is approved or still waiting for the CEO, and not withdrawn. Closing
//     an old v1 while v2 is live, or a pending revision while v1 is live, is
//     housekeeping: the quote is withdrawn and the lead stays where it is.
//   - A quote the dealer has APPROVED cannot be withdrawn. The dealer said
//     yes; the lead is Commercials finalised and the only ways on are Mark Won
//     and Mark Lost (S3).
//   - Withdraw never moves a lead out of Commercials finalised, for the same
//     reason — statusRules allows quote_withdrawn only from the two stages
//     before it.
//   - A quote waiting for the CEO can be withdrawn (it then leaves his queue);
//     a rejected one cannot — it is already closed.
//
// A lead awaiting a field visit keeps that status; its pre_transfer_status is
// lowered instead, so the visit does not restore a stage the quote no longer
// supports.
//
// One writer for the web route and the WhatsApp Assistant's withdraw_quote.
// The caller has already checked who may withdraw (owner or manager).
//
// ID 135: the LEAD row is locked first (lockLeadForQuote), before the quote
// row, so two withdrawals of different versions on one lead — or a withdrawal
// and a CEO reject — run one after the other. Locking only the quote row let
// both see the other's version still "in play" and leave the lead at a
// commercials stage with no quote. The CEO reject route takes the same locks in
// the same order and reuses quotesInPlay + leadMoveOnWithdraw.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class WithdrawQuoteError extends Error {
    readonly status: number;
    constructor(message: string, status = 409) {
        super(message);
        this.status = status;
    }
}

/** The stages a withdrawn quote sends back to Under discussion. Not Commercials finalised. */
const BEFORE_FINAL = new Set(["Commercials_Explained", "Awaiting_Customer_Decision"]);

export type WithdrawableQuote = {
    event_type: string;
    approval_status: string | null;
    dealer_decision: string | null;
    withdrawn_at: string | null;
    lead_status: string | null;
};

/**
 * Why this quote cannot be withdrawn, or null when it can. Pure — shared with
 * the WhatsApp Assistant's preview, so a proposal is refused for the same
 * reason the write would be.
 */
export function withdrawRefusal(q: WithdrawableQuote): { message: string; status: number } | null {
    if (!["quote_issue", "quote_revision"].includes(q.event_type)) {
        return { message: "Only a quote can be withdrawn.", status: 400 };
    }
    if (q.withdrawn_at) return { message: "This quote is already withdrawn.", status: 409 };
    if (q.approval_status === "rejected") {
        return { message: "This quote was rejected by the CEO; there is nothing to withdraw.", status: 409 };
    }
    if (q.dealer_decision === "approved") {
        return {
            message: "The dealer has approved this quote, so it cannot be withdrawn. Mark the lead Won or Lost instead.",
            status: 409,
        };
    }
    if (q.lead_status === "Won" || q.lead_status === "Converted" || q.lead_status === "Lost") {
        return { message: `The lead is ${q.lead_status}; its quote cannot be withdrawn.`, status: 409 };
    }
    return null;
}

/**
 * Where a withdrawal leaves the lead. Pure.
 *
 *   "back"         → Under discussion (a status change, event quote_withdrawn)
 *   "pre_transfer" → the lead is awaiting a field visit: lower pre_transfer_status
 *   "stay"         → nothing moves
 */
export function leadMoveOnWithdraw(input: {
    leadStatus: string | null;
    preTransferStatus: string | null;
    /** Another quote version is still approved or waiting for the CEO, and not withdrawn. */
    quoteStillInPlay: boolean;
}): "back" | "pre_transfer" | "stay" {
    if (input.quoteStillInPlay) return "stay";
    if (input.leadStatus && BEFORE_FINAL.has(input.leadStatus)) return "back";
    if (
        input.leadStatus === "Transferred_to_ASM" &&
        input.preTransferStatus &&
        BEFORE_FINAL.has(input.preTransferStatus)
    ) {
        return "pre_transfer";
    }
    return "stay";
}

type Row = WithdrawableQuote & {
    quote_number: string | null;
    version_no: number;
    pre_transfer_status: string | null;
};

export type QuoteLockedLead = {
    lead_status: string | null;
    pre_transfer_status: string | null;
    current_owner_id: string | null;
    dealer_name: string | null;
};

/**
 * ID 135 — lock the lead row (FOR UPDATE) for a quote close: a withdrawal or a
 * CEO reject. Take it BEFORE locking any dealer_lead_commercials row, in every
 * caller, so the lock order is always lead → quote and two closes cannot
 * deadlock. writeTouchpoint locks the same row again later, which is a no-op
 * inside the same transaction. Null when the lead does not exist.
 */
export async function lockLeadForQuote(tx: Tx, leadId: string): Promise<QuoteLockedLead | null> {
    const rows = (await tx.execute<QuoteLockedLead>(sql`
        SELECT lead_status, pre_transfer_status, current_owner_id, dealer_name
          FROM dealer_leads
         WHERE id = ${leadId}
         FOR UPDATE
    `)) as unknown as QuoteLockedLead[];
    return rows[0] ?? null;
}

export type QuoteInPlay = { version_no: number; quote_number: string | null; approval_status: string | null };

/**
 * The quote versions still in play on a lead: approved or waiting for the CEO,
 * and not withdrawn — newest first. Read after the close was written, inside
 * the same transaction. Shared by withdraw and the CEO reject (ID 135).
 */
export async function quotesInPlay(tx: Tx, leadId: string): Promise<QuoteInPlay[]> {
    return (await tx.execute<QuoteInPlay>(sql`
        SELECT q.version_no, q.quote_number, q.approval_status
          FROM dealer_lead_commercials q
         WHERE q.dealer_lead_id = ${leadId}
           AND q.event_type IN ('quote_issue', 'quote_revision')
           AND q.approval_status IN ('approved', 'pending')
           AND q.withdrawn_at IS NULL
         ORDER BY q.version_no DESC
    `)) as unknown as QuoteInPlay[];
}

export type WithdrawQuoteResult = {
    quoteNumber: string | null;
    leadStatus: string | null;
    /** The quote the dealer can still answer after this withdrawal, if any. */
    liveQuote: { versionNo: number; quoteNumber: string | null } | null;
};

export async function withdrawQuote(
    input: {
        leadId: string;
        commercialId: string;
        actorId: string;
        reason: string;
    },
    opts?: { tx?: Tx },
): Promise<WithdrawQuoteResult> {
    const run = async (tx: Tx): Promise<WithdrawQuoteResult> => {
        // ID 135: the lead first, then the quote row — see lockLeadForQuote.
        const lead = await lockLeadForQuote(tx, input.leadId);
        if (!lead) throw new WithdrawQuoteError("Quote not found.", 404);
        const rows = (await tx.execute<Row>(sql`
            SELECT c.event_type, c.quote_number, c.version_no, c.approval_status, c.dealer_decision,
                   c.withdrawn_at::text AS withdrawn_at,
                   dl.lead_status, dl.pre_transfer_status
              FROM dealer_lead_commercials c
              JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
             WHERE c.commercial_id = ${input.commercialId}::uuid
               AND c.dealer_lead_id = ${input.leadId}
             FOR UPDATE OF c
        `)) as unknown as Row[];
        const q = rows[0];
        if (!q) throw new WithdrawQuoteError("Quote not found.", 404);
        const refusal = withdrawRefusal(q);
        if (refusal) throw new WithdrawQuoteError(refusal.message, refusal.status);

        await tx.execute(sql`
            UPDATE dealer_lead_commercials
               SET withdrawn_at = NOW(), withdrawn_by = ${input.actorId},
                   withdraw_reason = ${input.reason}, updated_at = NOW()
             WHERE commercial_id = ${input.commercialId}::uuid
        `);

        // What is left once this one is gone: the other versions that are
        // approved or still at the CEO, and not withdrawn. The newest approved
        // one is the quote the dealer can still answer.
        const rest = await quotesInPlay(tx, input.leadId);
        const live = rest.find((r) => r.approval_status === "approved") ?? null;
        const liveQuote = live ? { versionNo: live.version_no, quoteNumber: live.quote_number } : null;

        const move = leadMoveOnWithdraw({
            leadStatus: q.lead_status,
            preTransferStatus: q.pre_transfer_status,
            quoteStillInPlay: rest.length > 0,
        });

        const remark =
            `Quote${q.quote_number ? ` ${q.quote_number}` : ""} (v${q.version_no}) withdrawn — ${input.reason}` +
            (liveQuote
                ? ` · v${liveQuote.versionNo}${liveQuote.quoteNumber ? ` ${liveQuote.quoteNumber}` : ""} is still live`
                : "");
        let leadStatus = q.lead_status;
        if (move === "back") {
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
            if (move === "pre_transfer") {
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
        return { quoteNumber: q.quote_number, leadStatus, liveQuote };
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
