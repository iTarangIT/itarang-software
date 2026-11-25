/**
 * Reject a PENDING lead quote — the one writer behind the CEO's Reject
 * (POST /api/dashboard/ceo/quotations/:id/decision) and the automatic
 * price-change rejection (25 Nov item 1, src/lib/quotes/priceChangeRecheck.ts).
 * Moved out of the route unchanged so both reject the same way.
 *
 * ID 135 rules, kept: the LEAD row is locked first, then the quote row (the
 * same order as withdrawQuote); the version is marked rejected and is_current
 * moves back to the newest approved, not-withdrawn version below it
 * (rollbackTarget); when no quote is left in play the lead goes back to Under
 * discussion through the status guard (event quote_rejected), or a lead awaiting
 * a field visit has its pre_transfer_status lowered. The timeline note is
 * written in the same transaction as the move.
 *
 * A system rejection (actor.id null) stamps approval_mode = 'system' and leaves
 * approved_by NULL: no person decided it.
 *
 * `notify()` runs after commit: bell + WhatsApp to the owner (and the person
 * who raised it, when that is someone else). Never throws.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { rollbackTarget, type CommercialVersion } from "@/lib/leads/quoteApproval";
import { leadMoveOnWithdraw, lockLeadForQuote, quotesInPlay, type QuoteLockedLead } from "@/lib/leads/withdrawQuote";
import { alertOwnerQuoteRejected } from "@/lib/leads/quoteRejectedNotice";
import { notifyUser } from "@/lib/notifications/notify";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

export type RejectLeadQuoteResult =
    | { status: 404 | 409; message: string }
    | {
          status: 200;
          leadId: string;
          versionNo: number;
          restoredVersion: number | null;
          notify: () => Promise<void>;
      };

export async function rejectPendingLeadQuote(input: {
    commercialId: string;
    /** id null = the system (price-change check). */
    actor: { id: string | null; name: string | null };
    reason: string;
}): Promise<RejectLeadQuoteResult> {
    const system = input.actor.id == null;
    const outcome = await db.transaction(async (tx) => {
        let rejectLead: QuoteLockedLead | null = null;
        const owner = await tx.execute<{ dealer_lead_id: string }>(sql`
            SELECT dealer_lead_id FROM dealer_lead_commercials WHERE commercial_id = ${input.commercialId}
        `);
        if (owner[0]) rejectLead = await lockLeadForQuote(tx, owner[0].dealer_lead_id);

        const locked = await tx.execute<{
            commercial_id: string;
            dealer_lead_id: string;
            version_no: number;
            quote_number: string | null;
            approval_status: string | null;
            price_quoted: string | null;
            final_price: string | null;
            withdrawn_at: string | null;
            created_by: string | null;
        }>(sql`
            SELECT commercial_id, dealer_lead_id, version_no, quote_number, approval_status,
                   price_quoted, final_price, withdrawn_at::text AS withdrawn_at, created_by
              FROM dealer_lead_commercials
             WHERE commercial_id = ${input.commercialId}
             FOR UPDATE
        `);
        const row = locked[0];
        if (!row) return { status: 404 as const, message: "Quotation not found." };
        if (row.withdrawn_at) {
            return {
                status: 409 as const,
                message: "This quotation was withdrawn by the sales team and can no longer be decided.",
            };
        }
        if (row.approval_status !== "pending") {
            return { status: 409 as const, message: `This quotation is already ${row.approval_status}.` };
        }

        // ISO string, never a Date, in a raw template (postgres.js unsafe()).
        const nowIso = new Date().toISOString();
        await tx.execute(sql`
            UPDATE dealer_lead_commercials
               SET approval_status = 'rejected',
                   approved_by = ${input.actor.id},
                   approved_at = ${nowIso},
                   rejection_reason = ${input.reason},
                   ${system ? sql`approval_mode = 'system',` : sql``}
                   is_current = false,
                   updated_at = NOW()
             WHERE commercial_id = ${input.commercialId}
        `);

        const siblings = await tx.execute<CommercialVersion>(sql`
            SELECT commercial_id, version_no, approval_status, withdrawn_at::text AS withdrawn_at
              FROM dealer_lead_commercials
             WHERE dealer_lead_id = ${row.dealer_lead_id}
        `);
        const target = rollbackTarget([...siblings], row.version_no);
        if (target) {
            await tx.execute(sql`
                UPDATE dealer_lead_commercials SET is_current = true, updated_at = NOW()
                 WHERE commercial_id = ${target.commercial_id}
            `);
        }

        const rest = await quotesInPlay(tx, row.dealer_lead_id);
        const live = rest.find((r) => r.approval_status === "approved") ?? null;
        const leadStatus = rejectLead?.lead_status ?? null;
        const move = leadMoveOnWithdraw({
            leadStatus,
            preTransferStatus: rejectLead?.pre_transfer_status ?? null,
            quoteStillInPlay: rest.length > 0,
        });
        const value = Number(row.final_price ?? row.price_quoted ?? 0);
        const money = value > 0 ? ` — ₹${value.toLocaleString("en-IN")}` : "";
        const remarks =
            `Quote${row.quote_number ? ` ${row.quote_number}` : ""} (v${row.version_no}) ` +
            `${system ? "rejected automatically" : "rejected by CEO"}${money} — ${input.reason}` +
            (target ? ` (restored v${target.version_no})` : " (lead left with no current quote)") +
            (move === "back" ? " · lead back to Under discussion" : "") +
            (move === "pre_transfer" ? " · stage after the field visit lowered to Under discussion" : "");

        if (move === "pre_transfer") {
            await tx.execute(sql`
                UPDATE dealer_leads SET pre_transfer_status = 'Under_Discussion' WHERE id = ${row.dealer_lead_id}
            `);
        }
        // A CEO (or system) decision is not the owner's work: the idle clock stays put.
        await writeTouchpoint(
            {
                dealerLeadId: row.dealer_lead_id,
                touchpointType: "quote_rejected",
                performedBy: input.actor.id,
                remarks,
                countsAsWork: false,
                ...(system ? { syncMethod: "system" as const } : {}),
                ...(move === "back"
                    ? {
                          statusChange: {
                              from: leadStatus as LeadStatus,
                              to: "Under_Discussion" as LeadStatus,
                              reasonNotes: input.reason,
                              event: "quote_rejected" as const,
                          },
                      }
                    : {}),
            },
            { tx },
        );

        const leadRows = await tx.execute<{ current_owner_id: string | null; dealer_name: string | null }>(sql`
            SELECT current_owner_id, dealer_name FROM dealer_leads WHERE id = ${row.dealer_lead_id} LIMIT 1
        `);
        const lead = rejectLead ?? leadRows[0] ?? { current_owner_id: null, dealer_name: null };
        return {
            status: 200 as const,
            leadId: row.dealer_lead_id,
            value,
            versionNo: row.version_no,
            quoteNumber: row.quote_number,
            createdBy: row.created_by,
            ownerId: lead.current_owner_id,
            dealerName: lead.dealer_name,
            restoredVersion: target?.version_no ?? null,
            leadMove: move,
            liveVersionNo: live?.version_no ?? null,
        };
    });

    if (outcome.status !== 200) return outcome;

    const notify = async () => {
        const notice = {
            dealerName: outcome.dealerName,
            quoteNumber: outcome.quoteNumber,
            versionNo: outcome.versionNo,
            value: outcome.value,
            reason: input.reason,
            rejectorName: system ? "The price check" : input.actor.name,
            leadMove: outcome.leadMove,
            liveVersionNo: outcome.liveVersionNo,
        };
        await alertOwnerQuoteRejected({
            leadId: outcome.leadId,
            commercialId: input.commercialId,
            ownerUserId: outcome.ownerId,
            notice,
        });
        // The person who raised it, when that is not the owner (a manager quoting on a rep's lead).
        if (outcome.createdBy && outcome.createdBy !== outcome.ownerId) {
            try {
                await notifyUser(outcome.createdBy, {
                    type: "quote.rejected",
                    title: system ? "Quote rejected: product price changed" : "Quote rejected",
                    message: `v${outcome.versionNo} for ${outcome.dealerName?.trim() || "the dealer"} was rejected: ${input.reason}`,
                    leadId: outcome.leadId,
                    data: { commercial_id: input.commercialId, reason: input.reason },
                });
            } catch (err) {
                console.error("[rejectQuote] creator notice failed", err instanceof Error ? err.message : err);
            }
        }
    };

    return {
        status: 200,
        leadId: outcome.leadId,
        versionNo: outcome.versionNo,
        restoredVersion: outcome.restoredVersion,
        notify,
    };
}
