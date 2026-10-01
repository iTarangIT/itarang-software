// The facts ownerAtClose() decides on (tracker ID 117), read from the database
// for every Won / Converted / Lost lead. Used by scripts/backfill-closing-owner.ts
// and exercised by scripts/verify-id117-closing-owner.ts. Read-only.
//
// WHEN A LEAD "CLOSED". Won at won_at; Lost at closed_at; Converted at won_at
// when it has one (the owner at Won is kept through to Converted), else
// closed_at.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    OWNERSHIP_MOVE_TYPES,
    asmTransferRecipientFromVisitSql,
    ownerAtClose,
    type CloseEvidence,
} from "./closingOwner";

export type ClosedLeadVerdict = {
    id: string;
    lead_status: string;
    closing_owner_id: string | null;
    /** Who held the lead at the close; null when nothing reliable says. */
    owner_at_close: string | null;
    evidence: CloseEvidence;
};

type Fact = {
    id: string;
    lead_status: string;
    closing_owner_id: string | null;
    current_owner_id: string | null;
    moved_after: boolean;
    first_after_from: string | null;
    last_before_to: string | null;
};

/** One verdict per closed lead (optionally just the given ids). */
export async function closedLeadVerdicts(leadIds?: string[]): Promise<ClosedLeadVerdict[]> {
    const moveTypes = sql.raw(OWNERSHIP_MOVE_TYPES.map((t) => `'${t}'`).join(", "));
    const only = leadIds
        ? sql`AND dl.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(leadIds)}::jsonb))`
        : sql``;
    const facts = (await db.execute<Fact>(sql`
        WITH closed AS (
            SELECT dl.id, dl.lead_status, dl.closing_owner_id, dl.current_owner_id,
                   CASE WHEN dl.lead_status = 'Lost' THEN dl.closed_at
                        ELSE COALESCE((to_jsonb(dl) ->> 'won_at')::timestamptz, dl.closed_at) END AS at
              FROM dealer_leads dl
             WHERE dl.lead_status IN ('Converted', 'Lost', 'Won') ${only}
        ), moves AS (
            -- Everything that changed who holds a lead, recorded hop or not. An
            -- old transfer to an ASM is read from the visit row it wrote.
            SELECT t.dealer_lead_id, t.performed_at, t.from_owner_id,
                   COALESCE(t.to_owner_id,
                            CASE WHEN t.touchpoint_type = 'asm_transfer'
                                 THEN ${sql.raw(asmTransferRecipientFromVisitSql("t"))} END) AS to_owner_id
              FROM lead_touchpoints t
             WHERE t.dealer_lead_id IN (SELECT id FROM closed)
               AND (t.to_owner_id IS NOT NULL
                    OR t.from_owner_id IS NOT NULL
                    OR t.touchpoint_type IN (${moveTypes}))
        )
        SELECT c.id, c.lead_status, c.closing_owner_id, c.current_owner_id,
               EXISTS (SELECT 1 FROM moves m
                        WHERE m.dealer_lead_id = c.id AND m.performed_at > c.at) AS moved_after,
               -- NULL when the first move after the close has no recorded "from".
               (SELECT m.from_owner_id FROM moves m
                 WHERE m.dealer_lead_id = c.id AND m.performed_at > c.at
                 ORDER BY m.performed_at ASC LIMIT 1) AS first_after_from,
               -- NULL when the last move before the close has no recorded "to".
               (SELECT m.to_owner_id FROM moves m
                 WHERE m.dealer_lead_id = c.id AND m.performed_at <= c.at
                 ORDER BY m.performed_at DESC LIMIT 1) AS last_before_to
          FROM closed c
         WHERE c.at IS NOT NULL
         ORDER BY c.lead_status, c.id
    `)) as unknown as Fact[];

    return facts.map((f) => {
        const { ownerId, evidence } = ownerAtClose({
            currentOwnerId: f.current_owner_id,
            movedAfter: f.moved_after,
            firstAfterFrom: f.first_after_from,
            lastBeforeTo: f.last_before_to,
        });
        return {
            id: f.id,
            lead_status: f.lead_status,
            closing_owner_id: f.closing_owner_id,
            owner_at_close: ownerId,
            evidence,
        };
    });
}
