// The Sales-ready event (tracker ID 82, handover P2-10, 29 Sep 2026).
//
// A lead is SALES-READY from a dated event with a reason — not from its
// creation date. The "awaiting assignment" clock starts here, and "Ready to
// assign" lists sales-ready leads nobody owns. First event wins: the date and
// reason are never moved by a later one.
//
// Written through a SAVEPOINT (E-314 columns, not in schema.ts): a DB without
// E-314 loses the event and nothing else.
//
// WHO IS "AWAITING ASSIGNMENT" is defined ONCE, here (awaitingAssignment):
// sales-ready, open, nobody owns it, and the number is not flagged dead or
// non-responsive. The CEO card, the Ready to assign page and the daily email's
// "Right now" box all read it, so they cannot disagree (review 30 Sep: the
// card counted dead numbers and the list did not).
//
// EVENTS (first one wins): the AI call qualified the lead; a rep created it
// (the Inside Sales / ASM form, the WhatsApp Assistant, the New Lead page); a
// rep claimed it; a NeoDove agent picked it up; an admin assigned it to
// someone (assignOwner.ts); a reviewer corrected its AI band to qualified
// (intentOverride.ts); it was reactivated — from Lost (reactivation.ts) or
// from a stalled onboarding (the drop-out resolve route). An upload that names
// an assignee and an escalation resolved by reassigning are admin assignments.
// So a lead that has ever had an owner is sales-ready.
//
// THE WAIT is counted from the Sales-ready event — or, for a lead that went
// back to the pool later (a Lost lead reactivated with nobody to return to),
// from the moment it went back (awaitingSince). The event's own date never
// moves; only the wait restarts, or a lead reactivated today would read
// "waiting 120 days" on the CEO card.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const SALES_READY_REASONS = [
    "ai_qualified",
    "rep_created",
    "claimed_by_rep",
    "neodove_pickup",
    "inbound_inquiry",
    "admin_marked",
    "admin_assigned",
    "reactivated",
] as const;
export type SalesReadyReason = (typeof SALES_READY_REASONS)[number];

const LABEL: Record<SalesReadyReason, string> = {
    ai_qualified: "qualified by the AI call",
    rep_created: "created by a rep",
    claimed_by_rep: "claimed by a rep",
    neodove_pickup: "picked up by a NeoDove agent",
    inbound_inquiry: "inbound inquiry",
    admin_marked: "marked qualified by a reviewer",
    admin_assigned: "assigned by an admin",
    reactivated: "reactivated into the sales pool",
};

export async function markSalesReady(
    exec: Tx | typeof db,
    input: { leadId: string; reason: SalesReadyReason; actorId: string | null; at?: Date },
): Promise<boolean> {
    const at = (input.at ?? new Date()).toISOString();
    try {
        let stamped = false;
        await exec.transaction(async (sp) => {
            const r = (await sp.execute<{ id: string }>(sql`
                UPDATE dealer_leads
                   SET sales_ready_at = ${at}::timestamptz, sales_ready_reason = ${input.reason}
                 WHERE id = ${input.leadId} AND sales_ready_at IS NULL
                RETURNING id
            `)) as unknown as Array<{ id: string }>;
            if (!r[0]) return;
            stamped = true;
            await writeTouchpoint(
                {
                    dealerLeadId: input.leadId,
                    touchpointType: "sales_ready",
                    performedBy: input.actorId,
                    performedAt: new Date(at),
                    remarks: `Sales-ready — ${LABEL[input.reason]}.`,
                    syncMethod: input.actorId ? "manual" : "system",
                },
                { tx: sp },
            );
        });
        return stamped;
    } catch (e) {
        console.warn("[salesReady] not recorded (E-314 applied?):", e instanceof Error ? e.message : e);
        return false;
    }
}

/**
 * The reason for a lead a person created by hand (the New Lead page, the
 * Inside Sales / ASM form, the WhatsApp Assistant): the dealer calling in
 * (Found via = Inbound call, ID 81) is an inbound inquiry; anything else is a
 * lead the rep went and found.
 */
export function createdByHandReason(origin: string | null | undefined): SalesReadyReason {
    return origin === "inbound_call" ? "inbound_inquiry" : "rep_created";
}

/** A sales-ready lead waiting this many days or more is overdue — the CEO card's number. */
export const AWAITING_ASSIGNMENT_OVERDUE_DAYS = 7;

/** For the page and the timeline: "ai_qualified" → "qualified by the AI call". */
export function salesReadyReasonLabel(reason: string | null | undefined): string {
    return LABEL[reason as SalesReadyReason] ?? (reason ?? "").replace(/_/g, " ");
}

/**
 * THE rule: a lead awaiting assignment. `dl` is the dealer_leads alias.
 * The E-314 columns are read through to_jsonb, so on a database without them
 * the predicate is simply false instead of failing the statement it is in.
 */
export function awaitingAssignment(dl: SQL = sql`dl`): SQL {
    return sql`${dl}.current_owner_id IS NULL
        AND ${dl}.is_active IS NOT FALSE
        AND COALESCE(${dl}.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
        AND (to_jsonb(${dl}) ->> 'sales_ready_at') IS NOT NULL
        AND (to_jsonb(${dl}) ->> 'contactability') IS NULL`;
}

/**
 * When the current wait began: the Sales-ready event, or the last time the
 * lead went back to "New / Unassigned" (status history) if that is later.
 */
export function awaitingSince(dl: SQL = sql`dl`): SQL {
    return sql`GREATEST(
        (to_jsonb(${dl}) ->> 'sales_ready_at')::timestamptz,
        COALESCE((SELECT MAX(h.changed_at) FROM dealer_lead_status_history h
                   WHERE h.dealer_lead_id = ${dl}.id AND h.to_status = 'New_Unassigned'),
                 '-infinity'::timestamptz))`;
}

/** Whole days the lead has been waiting — since awaitingSince(). */
export function daysAwaitingAssignment(dl: SQL = sql`dl`): SQL {
    return sql`FLOOR(EXTRACT(EPOCH FROM (now() - ${awaitingSince(dl)})) / 86400)::int`;
}

export type AwaitingAssignmentCounts = {
    /** Every lead awaiting assignment. */
    total: number;
    /** Of those, waiting AWAITING_ASSIGNMENT_OVERDUE_DAYS or more. */
    overdue: number;
    /** The longest wait, in days; null when nothing is waiting. */
    oldestDays: number | null;
};

/** The numbers every surface shows. Never throws — a failure reads as zero. */
export async function countAwaitingAssignment(): Promise<AwaitingAssignmentCounts> {
    try {
        const [r] = (await db.execute(sql`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE ${daysAwaitingAssignment()} >= ${AWAITING_ASSIGNMENT_OVERDUE_DAYS})::int AS overdue,
                   MAX(${daysAwaitingAssignment()}) AS oldest
              FROM dealer_leads dl
             WHERE ${awaitingAssignment()}
        `)) as unknown as Array<{ total: number; overdue: number; oldest: number | null }>;
        return { total: Number(r?.total ?? 0), overdue: Number(r?.overdue ?? 0), oldestDays: r?.oldest == null ? null : Number(r.oldest) };
    } catch (e) {
        console.warn("[salesReady] count failed:", e instanceof Error ? e.message : e);
        return { total: 0, overdue: 0, oldestDays: null };
    }
}

export type ReadyToAssignRow = {
    id: string;
    dealer_name: string | null;
    city: string | null;
    state: string | null;
    lead_status: string | null;
    interest_level: string | null;
    sales_ready_at: string;
    sales_ready_reason: string | null;
    days_waiting: number;
};

/**
 * Ready to assign: the leads awaitingAssignment(), oldest wait first.
 * `minDays` narrows it to leads waiting at least that long — the CEO card
 * links here with ?min_days=7, so the list it opens is the number it showed.
 */
export async function listReadyToAssign(opts: { minDays?: number; limit?: number } = {}): Promise<ReadyToAssignRow[]> {
    const limit = opts.limit ?? 500;
    const minDays = Math.max(0, Math.floor(opts.minDays ?? 0));
    try {
        return (await db.execute<ReadyToAssignRow>(sql`
            SELECT dl.id, COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name, dl.city, dl.state,
                   dl.lead_status, dl.interest_level,
                   (to_jsonb(dl) ->> 'sales_ready_at') AS sales_ready_at,
                   (to_jsonb(dl) ->> 'sales_ready_reason') AS sales_ready_reason,
                   ${daysAwaitingAssignment()} AS days_waiting
              FROM dealer_leads dl
             WHERE ${awaitingAssignment()}
               ${minDays > 0 ? sql`AND ${daysAwaitingAssignment()} >= ${minDays}` : sql``}
             ORDER BY ${awaitingSince()} ASC
             LIMIT ${limit}
        `)) as unknown as ReadyToAssignRow[];
    } catch (e) {
        console.warn("[salesReady] list failed:", e instanceof Error ? e.message : e);
        return [];
    }
}
