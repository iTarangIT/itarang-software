// Transfer a lead to an ASM (BRD §0.8). Extracted from
// POST /api/inside-sales/lead/[id]/transfer-asm so the screen and the WhatsApp
// Assistant hand off exactly the same way.
//
// ONE transaction: owner/asm_id/pre_transfer_status, the lead_visits row and the
// asm_transfer touchpoint + status history commit together. (The route used to
// write the touchpoint after its transaction, so a failure there left the lead
// owned by the ASM without the Transferred_to_ASM status.)
//
// Ownership is the CALLER's job: an inside-sales rep must own the lead
// (assertOwner); a manager in TRANSFER_ANY_LEAD_ROLES may transfer any lead.
//
// After the commit the caller runs notifyAsmOfTransfer(): the ASM gets a bell
// that opens the lead on their own page (/asm/lead/[id]) — and (ID 179) the
// rep who owned the lead gets one when a manager pressed Transfer.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadVisits } from "@/lib/db/schema";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { type LeadStatus } from "@/lib/lifecycle/transitions";
import { notifyUser } from "@/lib/notifications/notify";
import { notifyPreviousOwners } from "@/lib/leads/newOwnerNotice";

// Role lists live in the client-safe access.ts (the lead page's action bar
// reads them); re-exported here for the route and the Assistant.
export { TRANSFER_TO_ASM_ROLES, TRANSFER_ANY_LEAD_ROLES, canTransferAnyLead } from "@/lib/leads/access";

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

/**
 * ID 120 — the lead is already Awaiting field visit (Transferred_to_ASM). A
 * second transfer (network retry, two tabs, web + WhatsApp together) would
 * overwrite pre_transfer_status with Transferred_to_ASM — so after the visit
 * the lead fell to Under_Discussion — and book a second visit.
 */
export class LeadAlreadyTransferredError extends Error {
    constructor() {
        super("This lead has already been transferred to an ASM and is awaiting a field visit");
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
        // ID 120: lock the row so a concurrent transfer waits here, then sees
        // the committed Transferred_to_ASM and is refused below.
        const stateRows = await tx.execute<{ lead_status: string | null; current_owner_id: string | null }>(sql`
            SELECT lead_status, current_owner_id FROM dealer_leads WHERE id = ${input.leadId} FOR UPDATE
        `);
        if (stateRows.length === 0) throw new TransferLeadNotFoundError();
        if (stateRows[0]?.lead_status === "Transferred_to_ASM") throw new LeadAlreadyTransferredError();
        // S3 (ID 115): a transfer only from an open stage. writeTouchpoint
        // enforces it; the transfer event is what lets the status drop to
        // Transferred_to_ASM from a later stage (pre_transfer_status keeps it).
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
                // E-295: who held the lead before — the rep, or (a manager's
                // transfer) the lead's owner at that moment, not the manager.
                fromOwnerId: stateRows[0]?.current_owner_id ?? input.actorId,
                toOwnerId: input.asmId,
                statusChange: { from: fromStatus, to: "Transferred_to_ASM", event: "transfer" },
            },
            { tx },
        );
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}

/**
 * The ASM's bell after a transfer — clicking it opens the lead on the ASM's
 * own page. Run AFTER the transfer commits; never throws (best-effort).
 */
export async function notifyAsmOfTransfer(input: {
    leadId: string;
    asmId: string;
    actorId: string;
    visitType?: string | null;
    suggestedVisitDate?: string | null;
}): Promise<void> {
    // ID 179: the rep who owned the lead at the transfer (from_owner_id of the
    // asm_transfer just written) hears that it moved, when someone else pressed.
    try {
        const prev = (await db.execute<{ owner: string | null }>(sql`
            SELECT from_owner_id AS owner FROM lead_touchpoints
             WHERE dealer_lead_id = ${input.leadId} AND touchpoint_type = 'asm_transfer'
             ORDER BY performed_at DESC LIMIT 1
        `)) as unknown as Array<{ owner: string | null }>;
        const visit = input.visitType ? input.visitType.replace(/_/g, " ").toLowerCase() : null;
        await notifyPreviousOwners({
            moves: [{ leadId: input.leadId, fromOwnerId: prev[0]?.owner ?? null }],
            toUserId: input.asmId,
            actorId: input.actorId,
            reason: visit ? `handed to the field (${visit})` : "handed to the field",
        });
    } catch (err) {
        console.error("[transfer-asm] previous-owner notification failed:", err);
    }
    if (!input.asmId || input.asmId === input.actorId) return;
    try {
        const rows = (await db.execute<{ dealer: string | null; city: string | null; actor: string | null; actor_role: string | null }>(sql`
            SELECT COALESCE(dl.shop_name, dl.dealer_name) AS dealer, dl.city,
                   (SELECT COALESCE(u.name, u.email) FROM users u WHERE u.id::text = ${input.actorId}) AS actor,
                   (SELECT u.role FROM users u WHERE u.id::text = ${input.actorId}) AS actor_role
              FROM dealer_leads dl WHERE dl.id = ${input.leadId}
        `)) as unknown as Array<{ dealer: string | null; city: string | null; actor: string | null; actor_role: string | null }>;
        const r = rows[0];
        const dealer = r?.dealer ?? "a dealer";
        const visit = input.visitType ? input.visitType.replace(/_/g, " ").toLowerCase() : "visit";
        const when = input.suggestedVisitDate ? ` on ${input.suggestedVisitDate}` : "";
        await notifyUser(input.asmId, {
            type: "lead.transferred_to_asm",
            title: "New lead transferred to you",
            message: `${r?.actor ?? "Someone"} transferred ${dealer}${r?.city ? ` (${r.city})` : ""} to you for a ${visit}${when}. Tap to open the lead.`,
            leadId: input.leadId,
            data: {
                href: `/asm/lead/${input.leadId}`,
                transferred_by: input.actorId,
                transferred_by_role: r?.actor_role ?? null,
            },
        });
    } catch (err) {
        console.error("[transfer-asm] ASM notification failed:", err);
    }
}
