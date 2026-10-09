// Undo Mark Won (tracker ID 134, agreed 3 Oct 2026) — the Sales Head reverses
// a Won marked by mistake. Ships with the removal of "Correct status" (ID 136),
// which until now was the only way to move a Won lead back.
//
//   When   only while the dealer has not submitted onboarding: the application
//          is still a draft, never submitted, with no documents. After that it
//          is a real drop-out and goes through the drop-out review.
//   Who    the owner asks ("Request undo"); the Sales Head approves in one
//          click. The Sales Head (or admin) may also undo directly — the
//          approver acting is the request and the approval in one.
//   What   reason required, written to the history as "Won undone: marked by
//          mistake — <reason>". The lead returns to the EXACT stage it was at
//          before Won (from_status of its Mark Won history row) with the same
//          owner. The draft application is withdrawn ("Marked Won by
//          mistake") and leaves every queue. Won date, closing owner and the
//          won-without-quote flag are cleared; the Mark Won history row gets
//          won_undone_at so Won counters skip it. Not a drop-out, not a Lost.
//   Where  every undo is listed in the Sales Head's "Won undone this week"
//          tile (salesHeadActions.ts); pending requests in "Undo requests".
//
// Needs E-333 (lead_won_undo_requests + two columns). On a DB without it the
// actions answer 503 and getWonUndoState reports `available: false`.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { OPEN_STATUSES, type LeadStatus } from "@/lib/lifecycle/transitions";
import { withLeadActor } from "@/lib/leads/actorContext";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { notifyRoles, notifyUser } from "@/lib/notifications/notify";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who approves (and may undo directly). */
export const WON_UNDO_APPROVER_ROLES = ["sales_head", "admin"] as const;

export const WON_UNDONE_HISTORY_PREFIX = "Won undone: marked by mistake";
export const WITHDRAWN_BY_UNDO_REASON = "Marked Won by mistake";

export class WonUndoError extends Error {
    constructor(
        message: string,
        readonly status = 409,
    ) {
        super(message);
        this.name = "WonUndoError";
    }
}

export type UndoFacts = {
    leadStatus: string | null;
    /** from_status of the latest Mark Won history row; undefined = no such row. */
    wonFrom: string | null | undefined;
    application: { status: string | null; submittedAt: string | null; documents: number } | null;
};

export type UndoVerdict = { ok: true; restoreStatus: LeadStatus } | { ok: false; reason: string };

/** Pure — may this Won be undone, and to which stage. */
export function checkWonUndo(f: UndoFacts): UndoVerdict {
    if (f.leadStatus !== "Won") {
        return { ok: false, reason: "Only a Won lead can have its Mark Won undone." };
    }
    const app = f.application;
    if (app && (app.status !== "draft" || app.submittedAt || app.documents > 0)) {
        return {
            ok: false,
            reason: "The dealer has already started onboarding (documents uploaded or sent for review). This is a drop-out now — it goes through the drop-out review.",
        };
    }
    const from = f.wonFrom;
    if (!from || from === "Won" || !(OPEN_STATUSES as readonly string[]).includes(from)) {
        return {
            ok: false,
            reason: "The stage this lead was at before Won is not on record, so it cannot be put back automatically.",
        };
    }
    return { ok: true, restoreStatus: from as LeadStatus };
}

function isMissingRelation(e: unknown): boolean {
    const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
    return code === "42P01" || code === "42703";
}

function needsMigration(e: unknown): never {
    if (isMissingRelation(e)) {
        throw new WonUndoError("Undo Mark Won is not set up on this database yet (migration E-333).", 503);
    }
    throw e;
}

type Exec = Pick<typeof db, "execute">;

async function readFacts(ex: Exec, leadId: string, lock: boolean) {
    const rows = (await ex.execute<{
        lead_status: string | null;
        current_owner_id: string | null;
        app_id: string | null;
    }>(sql`
        SELECT lead_status, current_owner_id, dealer_onboarding_application_id::text AS app_id
          FROM dealer_leads WHERE id = ${leadId}
        ${lock ? sql`FOR UPDATE` : sql``}
    `)) as unknown as Array<{ lead_status: string | null; current_owner_id: string | null; app_id: string | null }>;
    const lead = rows[0];
    if (!lead) throw new WonUndoError("Lead not found", 404);

    const won = (await ex.execute<{ history_id: string; from_status: string | null }>(sql`
        SELECT history_id::text AS history_id, from_status
          FROM dealer_lead_status_history
         WHERE dealer_lead_id = ${leadId} AND to_status = 'Won'
         ORDER BY changed_at DESC
         LIMIT 1
    `)) as unknown as Array<{ history_id: string; from_status: string | null }>;

    // The application linked to the lead, else the one created from it.
    const apps = (await ex.execute<{ id: string; onboarding_status: string | null; submitted_at: string | null; documents: number }>(sql`
        SELECT oa.id::text AS id, oa.onboarding_status, oa.submitted_at::text AS submitted_at,
               (SELECT COUNT(*) FROM dealer_onboarding_documents d WHERE d.application_id = oa.id)::int AS documents
          FROM dealer_onboarding_applications oa
         WHERE oa.id::text = ${lead.app_id} OR oa.originating_dealer_lead_id = ${leadId}
         ORDER BY (oa.id::text = ${lead.app_id}) DESC NULLS LAST
         LIMIT 1
    `)) as unknown as Array<{ id: string; onboarding_status: string | null; submitted_at: string | null; documents: number }>;
    const app = apps[0] ?? null;

    const facts: UndoFacts = {
        leadStatus: lead.lead_status,
        wonFrom: won[0] ? won[0].from_status : undefined,
        application: app ? { status: app.onboarding_status, submittedAt: app.submitted_at, documents: Number(app.documents) } : null,
    };
    return { lead, wonHistoryId: won[0]?.history_id ?? null, appId: app?.id ?? null, facts };
}

export type PendingUndo = {
    id: string;
    requested_by: string;
    requested_by_name: string | null;
    requested_at: string;
    request_reason: string;
};

export type WonUndoState = {
    /** False when E-333 is not applied on this DB. */
    available: boolean;
    verdict: UndoVerdict;
    pending: PendingUndo | null;
};

/** What the lead page shows: may it be undone, and is a request waiting. */
export async function getWonUndoState(leadId: string): Promise<WonUndoState> {
    const { facts } = await readFacts(db, leadId, false);
    const verdict = checkWonUndo(facts);
    try {
        const rows = (await db.execute<PendingUndo>(sql`
            SELECT r.id::text AS id, r.requested_by, u.name AS requested_by_name,
                   r.requested_at::text AS requested_at, r.request_reason
              FROM lead_won_undo_requests r
              LEFT JOIN users u ON u.id::text = r.requested_by
             WHERE r.dealer_lead_id = ${leadId} AND r.status = 'pending'
             LIMIT 1
        `)) as unknown as PendingUndo[];
        return { available: true, verdict, pending: rows[0] ?? null };
    } catch (e) {
        if (isMissingRelation(e)) return { available: false, verdict, pending: null };
        throw e;
    }
}

function cleanReason(reason: string): string {
    const r = reason.trim();
    if (r.length < 5) throw new WonUndoError("Write a reason of at least 5 characters.", 400);
    return r;
}

/** The owner asks the Sales Head to undo their Mark Won. Ownership is the caller's job. */
export async function requestWonUndo(input: {
    leadId: string;
    actor: { id: string; name: string };
    reason: string;
}): Promise<{ requestId: string }> {
    const reason = cleanReason(input.reason);
    const requestId = await withLeadActor(input.actor.id, async (tx) => {
        const { facts, wonHistoryId, appId } = await readFacts(tx, input.leadId, true);
        const verdict = checkWonUndo(facts);
        if (!verdict.ok) throw new WonUndoError(verdict.reason);
        try {
            const rows = (await tx.execute<{ id: string }>(sql`
                INSERT INTO lead_won_undo_requests
                    (dealer_lead_id, won_history_id, restore_status, onboarding_application_id,
                     status, requested_by, request_reason)
                VALUES (${input.leadId}, ${wonHistoryId}::uuid, ${verdict.restoreStatus}, ${appId}::uuid,
                        'pending', ${input.actor.id}, ${reason})
                ON CONFLICT (dealer_lead_id) WHERE status = 'pending' DO NOTHING
                RETURNING id::text AS id
            `)) as unknown as Array<{ id: string }>;
            if (!rows[0]) throw new WonUndoError("An undo is already waiting for the Sales Head on this lead.");
            return rows[0].id;
        } catch (e) {
            if (e instanceof WonUndoError) throw e;
            needsMigration(e);
        }
    });

    try {
        await notifyRoles(["sales_head"], {
            type: "won_undo_requested",
            title: "Undo Mark Won requested",
            message: `${input.actor.name} asks to undo a Mark Won: ${reason}`,
            leadId: input.leadId,
            data: { won_undo_request_id: requestId },
        });
    } catch (err) {
        console.error("[won-undo] request notification failed:", err);
    }
    return { requestId };
}

/** The undo itself, inside the caller's transaction (lead row re-read and locked). */
async function performUndo(
    tx: Tx,
    leadId: string,
    actorId: string,
    reason: string,
): Promise<{ restoreStatus: LeadStatus; appId: string | null }> {
    const { facts, wonHistoryId, appId } = await readFacts(tx, leadId, true);
    const verdict = checkWonUndo(facts);
    if (!verdict.ok) throw new WonUndoError(verdict.reason);

    // Won → the stage before it. writeTouchpoint clears closed_at / closing
    // owner / closing role on leaving Won; the owner is untouched.
    await writeTouchpoint(
        {
            dealerLeadId: leadId,
            touchpointType: "status_change_note",
            performedBy: actorId,
            remarks: `${WON_UNDONE_HISTORY_PREFIX} — ${reason}. Back to ${verdict.restoreStatus.replace(/_/g, " ")}.`,
            countsAsWork: false,
            statusChange: {
                from: "Won",
                to: verdict.restoreStatus,
                reasonNotes: `${WON_UNDONE_HISTORY_PREFIX} — ${reason}`,
                event: "won_undone",
            },
        },
        { tx },
    );

    await tx.execute(sql`
        UPDATE dealer_leads
           SET won_at = NULL,
               won_without_approved_quote = false,
               dealer_onboarding_application_id = NULL
         WHERE id = ${leadId}
    `);
    if (wonHistoryId) {
        await tx.execute(sql`
            UPDATE dealer_lead_status_history SET won_undone_at = NOW() WHERE history_id = ${wonHistoryId}::uuid
        `);
    }
    if (appId) {
        await tx.execute(sql`
            UPDATE dealer_onboarding_applications
               SET onboarding_status = 'withdrawn',
                   withdrawn_at = NOW(),
                   withdrawn_reason = ${WITHDRAWN_BY_UNDO_REASON},
                   last_action_by = ${actorId}::uuid,
                   last_action_at = NOW(),
                   updated_at = NOW()
             WHERE id = ${appId}::uuid AND onboarding_status = 'draft'
        `);
    }
    await tx.insert(auditLogs).values({
        id: randomUUID(),
        entity_type: "dealer_lead",
        entity_id: leadId,
        action: "won_undone",
        performed_by: actorId,
        new_data: { restore_status: verdict.restoreStatus, onboarding_application_id: appId, reason },
        timestamp: new Date(),
    });
    return { restoreStatus: verdict.restoreStatus, appId };
}

/** performUndo for scripts that run inside their own (rolled-back) transaction. */
export const undoWonInTx = performUndo;

/** The Sales Head approves or rejects the waiting request on a lead. */
export async function decideWonUndo(input: {
    leadId: string;
    actor: { id: string; name: string };
    approve: boolean;
    note?: string | null;
}): Promise<{ restoreStatus: LeadStatus | null }> {
    const note = input.note?.trim() || null;
    let requester: string | null = null;
    const restoreStatus = await withLeadActor(input.actor.id, async (tx) => {
        let req: { id: string; requested_by: string; request_reason: string } | undefined;
        try {
            const rows = (await tx.execute<{ id: string; requested_by: string; request_reason: string }>(sql`
                SELECT id::text AS id, requested_by, request_reason
                  FROM lead_won_undo_requests
                 WHERE dealer_lead_id = ${input.leadId} AND status = 'pending'
                 FOR UPDATE
            `)) as unknown as Array<{ id: string; requested_by: string; request_reason: string }>;
            req = rows[0];
        } catch (e) {
            needsMigration(e);
        }
        if (!req) throw new WonUndoError("There is no undo request waiting on this lead.", 404);
        requester = req.requested_by;

        let restored: LeadStatus | null = null;
        if (input.approve) {
            const done = await performUndo(tx, input.leadId, input.actor.id, req.request_reason);
            restored = done.restoreStatus;
        } else if (!note || note.length < 5) {
            throw new WonUndoError("Say why the undo is refused (at least 5 characters).", 400);
        }
        await tx.execute(sql`
            UPDATE lead_won_undo_requests
               SET status = ${input.approve ? "approved" : "rejected"},
                   restore_status = COALESCE(${restored}::text, restore_status),
                   decided_by = ${input.actor.id}, decided_at = NOW(), decision_note = ${note}::text
             WHERE id = ${req.id}::uuid
        `);
        return restored;
    });

    if (requester && requester !== input.actor.id) {
        try {
            await notifyUser(requester, {
                type: input.approve ? "won_undo_approved" : "won_undo_rejected",
                title: input.approve ? "Mark Won undone" : "Undo Mark Won refused",
                message: input.approve
                    ? `${input.actor.name} undid the Mark Won. The lead is back at ${String(restoreStatus).replace(/_/g, " ")}.`
                    : `${input.actor.name} refused the undo${note ? `: ${note}` : "."}`,
                leadId: input.leadId,
                data: {},
            });
        } catch (err) {
            console.error("[won-undo] decision notification failed:", err);
        }
    }
    return { restoreStatus };
}

/** The Sales Head (or admin) undoes a Mark Won without a request. */
export async function undoWonDirect(input: {
    leadId: string;
    actor: { id: string };
    reason: string;
}): Promise<{ restoreStatus: LeadStatus }> {
    const reason = cleanReason(input.reason);
    return withLeadActor(input.actor.id, async (tx) => {
        // A waiting request is superseded by the direct undo.
        let hasPending = false;
        try {
            const rows = (await tx.execute<{ id: string }>(sql`
                SELECT id::text AS id FROM lead_won_undo_requests
                 WHERE dealer_lead_id = ${input.leadId} AND status = 'pending' FOR UPDATE
            `)) as unknown as Array<{ id: string }>;
            hasPending = rows.length > 0;
        } catch (e) {
            needsMigration(e);
        }
        const { wonHistoryId, appId } = await readFacts(tx, input.leadId, true);
        const { restoreStatus } = await performUndo(tx, input.leadId, input.actor.id, reason);
        if (hasPending) {
            await tx.execute(sql`
                UPDATE lead_won_undo_requests
                   SET status = 'approved', restore_status = ${restoreStatus},
                       decided_by = ${input.actor.id}, decided_at = NOW(), decision_note = ${reason}
                 WHERE dealer_lead_id = ${input.leadId} AND status = 'pending'
            `);
        } else {
            await tx.execute(sql`
                INSERT INTO lead_won_undo_requests
                    (dealer_lead_id, won_history_id, restore_status, onboarding_application_id, status,
                     requested_by, request_reason, decided_by, decided_at)
                VALUES (${input.leadId}, ${wonHistoryId}::uuid, ${restoreStatus}, ${appId}::uuid, 'approved',
                        ${input.actor.id}, ${reason}, ${input.actor.id}, NOW())
            `);
        }
        return { restoreStatus };
    });
}
