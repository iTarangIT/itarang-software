// Transfer a lead to an ASM (BRD §0.8). Extracted from
// POST /api/inside-sales/lead/[id]/transfer-asm so the screen and the WhatsApp
// Assistant hand off exactly the same way.
//
// ONE transaction: owner/asm_id/pre_transfer_status, the lead_visits row and the
// asm_transfer touchpoint + status history commit together. (The route used to
// write the touchpoint after its transaction, so a failure there left the lead
// owned by the ASM without the Transferred_to_ASM status.)
//
// Ownership is the CALLER's job (assertOwner before calling).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadVisits } from "@/lib/db/schema";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { type LeadStatus } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const TRANSFER_REASONS = [
    "Commercials_Finalised",
    "Site_Visit_Needed",
    "Negotiation_Beyond_IS_Authority",
    "Demo_Requested",
    "Other",
] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];

export const VISIT_TYPES = ["Initial_Visit", "Demo", "Negotiation", "Closing"] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

export class TransferLeadNotFoundError extends Error {
    constructor() {
        super("Lead not found");
    }
}

export type TransferToAsmInput = {
    leadId: string;
    actorId: string;
    asmId: string;
    reason: TransferReason;
    visitType: VisitType;
    /** YYYY-MM-DD */
    suggestedVisitDate?: string | null;
    dealerPreferredTime?: string | null;
    handoffNotes?: string;
    pendingItems?: string[];
    outOfTerritoryReason?: string | null;
};

export function buildTransferRemarks(i: TransferToAsmInput): string {
    return `Reason: ${i.reason}; Visit: ${i.visitType}${
        i.suggestedVisitDate ? `; Date: ${i.suggestedVisitDate}` : ""
    }${i.dealerPreferredTime ? ` (${i.dealerPreferredTime})` : ""}\n\n${i.handoffNotes ?? ""}${
        i.pendingItems?.length ? `\n\nPending: ${i.pendingItems.join(", ")}` : ""
    }${i.outOfTerritoryReason ? `\n\nOut-of-territory: ${i.outOfTerritoryReason}` : ""}`;
}

export async function transferLeadToAsm(input: TransferToAsmInput, opts?: { tx?: Tx }): Promise<void> {
    const run = async (tx: Tx) => {
        const stateRows = await tx.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1
        `);
        if (stateRows.length === 0) throw new TransferLeadNotFoundError();
        // Lifecycle transition gate intentionally absent: a transfer to a chosen
        // ASM is always allowed regardless of current lead_status.
        const fromStatus = stateRows[0]?.lead_status as LeadStatus | null;

        await tx.execute(sql`
            UPDATE dealer_leads
            SET pre_transfer_status = lead_status,
                current_owner_id = ${input.asmId},
                asm_id = ${input.asmId},
                assigned_at = NOW(),
                updated_at = NOW()
            WHERE id = ${input.leadId}
        `);
        await tx.insert(leadVisits).values({
            dealer_lead_id: input.leadId,
            asm_id: input.asmId,
            scheduled_date: input.suggestedVisitDate ?? null,
            visit_status: input.suggestedVisitDate ? "scheduled" : "pending_scheduling",
        });

        await writeTouchpoint(
            {
                dealerLeadId: input.leadId,
                touchpointType: "asm_transfer",
                performedBy: input.actorId,
                remarks: buildTransferRemarks(input),
                // E-295: the caller's assertOwner proved the actor held the lead.
                fromOwnerId: input.actorId,
                toOwnerId: input.asmId,
                statusChange: { from: fromStatus, to: "Transferred_to_ASM" },
            },
            { tx },
        );
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
