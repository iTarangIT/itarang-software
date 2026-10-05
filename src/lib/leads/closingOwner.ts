// Who held a lead when it closed (tracker ID 117) — the rule the closing-owner
// backfill uses to check dealer_leads.closing_owner_id on leads closed before
// the status writer recorded it correctly. Pure: no db import, unit-tested.
//
// A "move" is anything that changes who holds a lead: an ownership hop with
// its from / to owner recorded (E-295), or an assign / claim / transfer /
// reassign touchpoint. Moves logged before E-295 carry NO from / to — they
// prove the lead changed hands, not to whom — so a recorded hop is trusted
// only where no unrecorded move stands between it and the close.

export type CloseEvidence = "not_moved_since" | "hop_after" | "hop_before" | "unknown";

export type CloseFacts = {
    /** dealer_leads.current_owner_id today. */
    currentOwnerId: string | null;
    /** Did anything move the lead after it closed? */
    movedAfter: boolean;
    /** from_owner_id of the FIRST move after the close; null when it was not recorded. */
    firstAfterFrom: string | null;
    /** to_owner_id of the LAST move at or before the close; null when it was not recorded (or there was none). */
    lastBeforeTo: string | null;
};

/**
 * The owner at the close, with the evidence it rests on. `ownerId` is null
 * when nothing reliable says who it was — the caller then leaves the lead's
 * closing owner as it is rather than guess.
 *
 *   not_moved_since  nothing moved the lead after it closed, so whoever holds
 *                    it now held it then. If the last recorded hop before the
 *                    close names someone else the two disagree → unknown.
 *   hop_after        the first move after the close recorded who the lead was
 *                    taken from — that is who held it at the close.
 *   hop_before       the last move before the close recorded who received it.
 *   unknown          anything else, typically a transfer logged without its
 *                    recipient next to the close.
 */
export function ownerAtClose(f: CloseFacts): { ownerId: string | null; evidence: CloseEvidence } {
    if (!f.movedAfter) {
        if (f.lastBeforeTo && f.currentOwnerId && f.lastBeforeTo !== f.currentOwnerId) {
            return { ownerId: null, evidence: "unknown" };
        }
        return { ownerId: f.currentOwnerId, evidence: "not_moved_since" };
    }
    if (f.firstAfterFrom) return { ownerId: f.firstAfterFrom, evidence: "hop_after" };
    if (f.lastBeforeTo) return { ownerId: f.lastBeforeTo, evidence: "hop_before" };
    return { ownerId: null, evidence: "unknown" };
}

/**
 * SQL for the ASM an `asm_transfer` touchpoint handed the lead to, when the
 * touchpoint itself did not record it (transfers before E-295).
 *
 * A transfer has always written the ASM's lead_visits row in the same
 * transaction, so the visit row created with the touchpoint names the
 * recipient as of that moment — unlike dealer_leads.asm_id, which is whoever
 * has the lead today. Checked on database-1 (01 Oct 2026): wherever a transfer
 * has both a recorded recipient and its visit row they agree (10 of 10), and
 * every unrecorded transfer has its visit row (3 of 3).
 *
 * `t` is the lead_touchpoints alias. Raw text, so this module stays db-free.
 */
export function asmTransferRecipientFromVisitSql(t: string): string {
    return `(SELECT v.asm_id FROM lead_visits v
              WHERE v.dealer_lead_id = ${t}.dealer_lead_id
                AND v.created_at BETWEEN ${t}.performed_at - INTERVAL '2 minutes'
                                     AND ${t}.performed_at + INTERVAL '2 minutes'
              ORDER BY abs(extract(epoch FROM (v.created_at - ${t}.performed_at)))
              LIMIT 1)`;
}

/** Touchpoint types that move a lead between owners, hop columns or not. */
export const OWNERSHIP_MOVE_TYPES = [
    "lead_assigned",
    "lead_claimed",
    "ownership_transfer",
    "asm_transfer",
    "escalation_resolved_reassign",
] as const;
