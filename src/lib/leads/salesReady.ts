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
import { TIME_LIMIT_DEFAULTS } from "@/lib/timeLimits/registry";
import { getTimeLimits, hasTimeLimitTable, limitOnDaySql } from "@/lib/timeLimits/store";
import { workingDaysSinceSql } from "@/lib/calendar/holidays";

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
    // AI dialer review (23 Oct 2026) — the dealer asked an AI call for a
    // callback on pricing / negotiation / dealership / purchase, or for a
    // Sales Manager (src/lib/ai-dialer/postCallOutcome.ts).
    "ai_callback",
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
    ai_callback: "asked an AI call for a callback from sales",
};

/** The reasons the "AI qualified" split of Ready to assign counts. */
const AI_READY_REASONS: readonly SalesReadyReason[] = ["ai_qualified", "ai_callback"];

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

/**
 * The old single limit (sales_ready_unassigned, calendar days) — kept only as
 * the record of what was in force before the 18 Oct rework. Nothing counts
 * against it now: see readyPastLimitSql().
 */
export const AWAITING_ASSIGNMENT_OVERDUE_DAYS = TIME_LIMIT_DEFAULTS.sales_ready_unassigned;

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

/** ID 184 — the one name every surface uses for awaitingAssignment(). */
export const READY_NO_OWNER_TITLE = "Ready leads with no owner";

/**
 * ID 184 — the card's split, one bucket per lead (no overlap). Decided 21 Oct:
 * AI-qualified first, then Hot (only when not AI-qualified), then everything
 * else (rep-created, NeoDove, inbound, …). The order here is the order shown.
 */
export const READY_SPLITS = ["ai", "hot", "other"] as const;
export type ReadySplit = (typeof READY_SPLITS)[number];
export const READY_SPLIT_LABEL: Record<ReadySplit, string> = { ai: "AI qualified", hot: "Hot", other: "other" };
// "AI qualified" also counts the AI's sales callbacks (ai_callback) — both are
// the AI dialer handing the lead to people.

export function isReadySplit(v: unknown): v is ReadySplit {
    return typeof v === "string" && (READY_SPLITS as readonly string[]).includes(v);
}

/** JS twin of readySplitSql(). */
export function readySplitOf(interestLevel: string | null | undefined, reason: string | null | undefined): ReadySplit {
    if ((AI_READY_REASONS as readonly string[]).includes(reason ?? "")) return "ai";
    return String(interestLevel ?? "").toLowerCase() === "hot" ? "hot" : "other";
}

/** The split bucket of a lead, as SQL text 'hot' | 'ai' | 'other'. */
export function readySplitSql(dl: SQL = sql`dl`): SQL {
    return sql`CASE WHEN (to_jsonb(${dl}) ->> 'sales_ready_reason') IN ('ai_qualified', 'ai_callback') THEN 'ai'
                    WHEN lower(COALESCE(${dl}.interest_level, '')) = 'hot' THEN 'hot'
                    ELSE 'other' END`;
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

/**
 * Working days the lead has been waiting — since awaitingSince(), on the
 * office calendar (working weekdays, holidays off; 18 Oct rework 1). Same
 * count as the ready_assign clock's limit.
 */
export function daysAwaitingAssignment(dl: SQL = sql`dl`): SQL {
    return workingDaysSinceSql(awaitingSince(dl));
}

/** Is the lead Hot (the split's rule)? */
const isHot = (dl: SQL) => sql`lower(COALESCE(${dl}.interest_level, '')) = 'hot'`;

/**
 * THE "past its limit" rule for a lead awaiting assignment (18 Oct rework 1):
 *   Hot      a running hot_assign clock past hot_ready_to_assigned (working
 *            hours — read from lead_clocks; without E-350 nothing is past)
 *   others   more working days waiting than ready_to_assigned in force on
 *            the day the wait began (default 2) — what the ready_assign
 *            clock records as "Limit passed"
 * `clocks` = lead_limit_events exists (E-350); `withTable` = hasTimeLimitTable().
 */
export function readyPastLimitSql(opts: { clocks: boolean; withTable: boolean }, dl: SQL = sql`dl`): SQL {
    const hotPast = opts.clocks
        ? sql`EXISTS (SELECT 1 FROM lead_clocks hc
                       WHERE hc.dealer_lead_id = ${dl}.id AND hc.clock = 'hot_assign'
                         AND hc.first_attempt_at IS NULL AND hc.ended_at IS NULL AND hc.limit_passed_at IS NOT NULL)`
        : sql`FALSE`;
    const limit = limitOnDaySql("ready_to_assigned", sql`((${awaitingSince(dl)}) AT TIME ZONE 'Asia/Kolkata')::date`, opts.withTable);
    return sql`(CASE WHEN ${isHot(dl)} THEN ${hotPast} ELSE ${daysAwaitingAssignment(dl)} > FLOOR(${limit}) END)`;
}

/** readyPastLimitSql with the probes done. */
export async function readyPastLimit(dl: SQL = sql`dl`): Promise<SQL> {
    const { hasLimitEvents } = await import("@/lib/leads/clocks");
    const [clocks, withTable] = await Promise.all([hasLimitEvents(), hasTimeLimitTable()]);
    return readyPastLimitSql({ clocks, withTable }, dl);
}

export type AwaitingAssignmentCounts = {
    /** Every lead awaiting assignment. */
    total: number;
    /** Of those, past their limit (Hot: hot_ready_to_assigned; others: ready_to_assigned). */
    overdue: number;
    /** …Hot leads past hot_ready_to_assigned. */
    hotPast: number;
    /** …other leads past ready_to_assigned. */
    otherPast: number;
    /** The ready_to_assigned limit in force today (working days). */
    overdueDays: number;
    /** The hot_ready_to_assigned limit in force today (working hours). */
    hotLimitHours: number;
    /** The longest wait, in working days; null when nothing is waiting. */
    oldestDays: number | null;
    /** The longest wait of a lead that is not Hot, in working days. */
    oldestOtherDays: number | null;
    /** ID 184 — AI qualified / Hot / other (AI first); sums to `total`. */
    split: Record<ReadySplit, number>;
};

/**
 * ID 184 — the Sales dashboard's state filter on a ready lead (`dl`). Ready
 * leads have no owner, so the person / team filters do not narrow them — the
 * card counts by state only, and so does the page it opens.
 */
function readyStateSql(state: string | null | undefined): SQL {
    const s = state?.trim();
    return s ? sql`AND lower(trim(dl.state)) = lower(trim(${s}))` : sql``;
}

/** The numbers every surface shows. Never throws — a failure reads as zero. `state` = the dashboard's state filter. */
export async function countAwaitingAssignment(opts: { state?: string | null } = {}): Promise<AwaitingAssignmentCounts> {
    const limits = await getTimeLimits();
    const empty: AwaitingAssignmentCounts = {
        total: 0,
        overdue: 0,
        hotPast: 0,
        otherPast: 0,
        overdueDays: limits.ready_to_assigned,
        hotLimitHours: limits.hot_ready_to_assigned,
        oldestDays: null,
        oldestOtherDays: null,
        split: { hot: 0, ai: 0, other: 0 },
    };
    try {
        const past = await readyPastLimit();
        const [r] = (await db.execute(sql`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE ${past} AND ${isHot(sql`dl`)})::int AS hot_past,
                   COUNT(*) FILTER (WHERE ${past} AND NOT ${isHot(sql`dl`)})::int AS other_past,
                   MAX(${daysAwaitingAssignment()}) AS oldest,
                   MAX(${daysAwaitingAssignment()}) FILTER (WHERE NOT ${isHot(sql`dl`)}) AS oldest_other,
                   COUNT(*) FILTER (WHERE ${readySplitSql()} = 'hot')::int AS hot,
                   COUNT(*) FILTER (WHERE ${readySplitSql()} = 'ai')::int AS ai
              FROM dealer_leads dl
             WHERE ${awaitingAssignment()} ${readyStateSql(opts.state)}
        `)) as unknown as Array<{
            total: number;
            hot_past: number;
            other_past: number;
            oldest: number | null;
            oldest_other: number | null;
            hot: number;
            ai: number;
        }>;
        const total = Number(r?.total ?? 0);
        const hot = Number(r?.hot ?? 0);
        const ai = Number(r?.ai ?? 0);
        const hotPast = Number(r?.hot_past ?? 0);
        const otherPast = Number(r?.other_past ?? 0);
        return {
            ...empty,
            total,
            overdue: hotPast + otherPast,
            hotPast,
            otherPast,
            oldestDays: r?.oldest == null ? null : Number(r.oldest),
            oldestOtherDays: r?.oldest_other == null ? null : Number(r.oldest_other),
            split: { hot, ai, other: total - hot - ai },
        };
    } catch (e) {
        console.warn("[salesReady] count failed:", e instanceof Error ? e.message : e);
        return empty;
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
    /** Working days waiting. */
    days_waiting: number;
    /** Past its limit (readyPastLimitSql). */
    past_limit: boolean;
};

/**
 * Ready to assign: the leads awaitingAssignment(), oldest wait first.
 * `minDays` narrows it to leads waiting at least that long — the CEO card
 * links here with ?min_days=<sales_ready_unassigned>, so the list it opens is
 * the number it showed.
 */
export async function listReadyToAssign(
    opts: { minDays?: number; limit?: number; split?: ReadySplit; pastLimit?: "hot" | "other" | "any"; state?: string | null } = {},
): Promise<ReadyToAssignRow[]> {
    const limit = opts.limit ?? 500;
    const minDays = Math.max(0, Math.floor(opts.minDays ?? 0));
    try {
        const past = await readyPastLimit();
        const pastCond =
            opts.pastLimit === "hot"
                ? sql`AND ${past} AND ${isHot(sql`dl`)}`
                : opts.pastLimit === "other"
                  ? sql`AND ${past} AND NOT ${isHot(sql`dl`)}`
                  : opts.pastLimit === "any"
                    ? sql`AND ${past}`
                    : sql``;
        return (await db.execute<ReadyToAssignRow>(sql`
            SELECT dl.id, COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name, dl.city, dl.state,
                   dl.lead_status, dl.interest_level,
                   (to_jsonb(dl) ->> 'sales_ready_at') AS sales_ready_at,
                   (to_jsonb(dl) ->> 'sales_ready_reason') AS sales_ready_reason,
                   ${daysAwaitingAssignment()} AS days_waiting,
                   ${past} AS past_limit
              FROM dealer_leads dl
             WHERE ${awaitingAssignment()}
               ${minDays > 0 ? sql`AND ${daysAwaitingAssignment()} >= ${minDays}` : sql``}
               ${opts.split ? sql`AND ${readySplitSql()} = ${opts.split}` : sql``}
               ${pastCond}
               ${readyStateSql(opts.state)}
             ORDER BY ${awaitingSince()} ASC
             LIMIT ${limit}
        `)) as unknown as ReadyToAssignRow[];
    } catch (e) {
        console.warn("[salesReady] list failed:", e instanceof Error ? e.message : e);
        return [];
    }
}
