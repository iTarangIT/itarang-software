// The status a DONE visit leaves the lead in (tracker ID 77, handover P2-5,
// 29 Sep 2026). One writer for the visit route, the WhatsApp Assistant's
// log_visit and "Visit not needed".
//
//   Awaiting field visit (Transferred_to_ASM) ends ONLY here: the lead goes to
//   the further of what the ASM chose and where it was before the transfer
//   (pre_transfer_status), and never below Under_Discussion — a lead transferred
//   at Commercials finalised no longer drops back to Under discussion.
//   Any other lead moves forward to what the ASM chose, if anything.
//
// ID 114 / 80 (01 Oct 2026): pass `outcome` and the status AND the
// temperature are derived here, on the server, from the visit outcome by the
// shared rule (outcomeRule.ts). The visit route and the WhatsApp Assistant's
// log_visit both do; a form's pre-fill or a card's preview is only a preview,
// and no caller can ASK for a status — `requested` is ignored when the outcome
// is given. Without `outcome` ("Visit not needed") only `requested` is
// applied, and that caller passes null.
//
// Runs on the caller's transaction; the S3 guard in writeTouchpoint still
// applies (event "visit").

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { setInterestLevel } from "@/lib/leads/interestLevel";
import { planOutcome, statusAfterVisit } from "@/lib/leads/outcomeRule";
import type { Interest } from "@/lib/leads/autoProgress";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import type { VisitOutcome } from "@/lib/asm/types";

// The pure rule lives with the rest of the outcome rule; re-exported so its
// existing importers and tests are unchanged.
export { statusAfterVisit };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type VisitLead = {
    lead_status: string | null;
    pre_transfer_status: string | null;
    current_owner_id: string | null;
    interest_level: string | null;
    interest_changed_at: string | null;
} & Record<string, unknown>;

export async function applyVisitStatus(
    tx: Tx,
    input: {
        leadId: string;
        actorId: string;
        requested: LeadStatus | null;
        remarks: string;
        /** The visit's outcome — set it to have status + temperature derived here. */
        outcome?: VisitOutcome | null;
        /** Temperature with the visit: a level, null = leave it, absent = derive from `outcome`. */
        interest?: Interest | null;
        interestReason?: string | null;
        /** ID 77.4: written to the status-history row's reason_notes. */
        reasonNotes?: string | null;
        /**
         * ID 77.4: false = this move is not rep work and must not reset the
         * idle clock ("Visit not needed"). Absent = writeTouchpoint's default.
         */
        countsAsWork?: boolean;
    },
): Promise<{ historyId: string | null; status: LeadStatus | null }> {
    const derive = input.outcome !== undefined;
    // Locked: the move and the temperature are decided against the lead as it
    // is now, and held until this transaction ends.
    const rows = (await tx.execute<VisitLead>(sql`
        SELECT lead_status, pre_transfer_status, current_owner_id, interest_level,
               ${derive ? sql`to_jsonb(dealer_leads) ->> 'interest_changed_at'` : sql`NULL::text`} AS interest_changed_at
          FROM dealer_leads WHERE id = ${input.leadId}
         FOR UPDATE
    `)) as unknown as VisitLead[];
    const lead = rows[0];
    if (!lead) return { historyId: null, status: null };

    let to: LeadStatus | null;
    let interestTo: Interest | null = null;
    if (derive) {
        const plan = planOutcome({
            outcome: { kind: "visit", visited: true, outcome: input.outcome ?? null },
            hasExplicitStatus: false,
            interest: input.interest,
            actorId: input.actorId,
            performedAt: new Date(),
            lead: {
                status: lead.lead_status,
                interest: lead.interest_level,
                preTransferStatus: lead.pre_transfer_status,
                ownerId: lead.current_owner_id,
                interestChangedAt: lead.interest_changed_at ? new Date(lead.interest_changed_at) : null,
            },
        });
        to = plan.statusTo;
        interestTo = plan.interestTo;
    } else {
        to = statusAfterVisit({
            current: lead.lead_status,
            preTransfer: lead.pre_transfer_status,
            requested: input.requested,
        });
    }

    let historyId: string | null = null;
    if (to) {
        const r = await writeTouchpoint(
            {
                dealerLeadId: input.leadId,
                touchpointType: "status_change_note",
                performedBy: input.actorId,
                remarks: input.remarks,
                statusChange: {
                    from: lead.lead_status as LeadStatus | null,
                    to,
                    event: "visit",
                    reasonNotes: input.reasonNotes ?? null,
                },
                ...(input.countsAsWork !== undefined ? { countsAsWork: input.countsAsWork } : {}),
            },
            { tx },
        );
        historyId = r.historyId;
    }
    if (interestTo) {
        await setInterestLevel(
            {
                leadId: input.leadId,
                actorId: input.actorId,
                level: interestTo,
                reason: input.interestReason ?? "Auto: from visit outcome",
            },
            { tx },
        );
    }
    return { historyId, status: to };
}
