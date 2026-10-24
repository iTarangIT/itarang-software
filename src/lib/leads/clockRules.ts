/**
 * Lead clocks (tracker ID 86) — the pure rules. No I/O: clocks.ts loads the
 * rows and writes the result; this decides every clock, so it is unit-tested.
 *
 *   lead      starts when the lead becomes sales-ready (sales_ready_at). A lead
 *             with an owner but no sales_ready_at starts at its first owner's
 *             assignment, flagged start_inferred. Ends never. First attempt =
 *             the first call or visit by ANYONE.
 *   owner     starts at every assignment (an owner-change touchpoint). A lead
 *             whose current owner has no such row gets one stint from
 *             assigned_at, flagged owner_inferred. Ends at the next assignment.
 *             First attempt = the first call or visit by THAT owner. A stint
 *             that starts with a Transfer to ASM (within 10 minutes) has no
 *             owner limit: the transfer clock governs that hand-off.
 *   transfer  starts at each move to Transferred_to_ASM, ends at the lead's
 *             next status change. First attempt = the first visit marked
 *             visited (the ASM transfer-visit limit, ID 77.1).
 *   hot_assign  (15 Oct) a Hot, sales-ready lead with no owner: from the later
 *             of turning Hot and sales-ready to its first assignment. Ends
 *             when the lead stops being Hot. Charged to nobody (the team).
 *   hot_owner   (15 Oct) a fresh owner clock whenever the lead is Hot under an
 *             owner: from the later of turning Hot and the assignment to that
 *             owner's first call or visit. A lead that turns Hot again later
 *             gets a new one.
 *   retry     from each call that did not connect to the next call or visit by
 *             anyone; only the first retry_max_attempts unanswered calls in a
 *             row are timed. Ends when the lead closes (Converted / Lost).
 *   quote     a quote sent to the CEO for approval: from submission to the
 *             CEO's decision (approved or rejected); ends if withdrawn.
 *             Charged to whoever decided, never to the rep.
 *   ready_assign  (18 Oct, rework 1) a sales-ready lead that is NOT Hot and
 *             has no owner: timed like hot_assign over the lead's non-Hot
 *             spans, against ready_to_assigned (2 working days). Charged to
 *             nobody (the team).
 *   quote_deliver (18 Oct, #5) an approved quote: from the approval to the
 *             first successful send of the quotation; ends when the quote is
 *             withdrawn or a newer version is raised. Charged to the owner
 *             when it fell due.
 *   quote_revise  (18 Oct, #5) a quote the dealer declined: from the decline
 *             to a newer quote version or the lead marked Lost. Charged to the
 *             owner when it fell due.
 *
 * Owner clock limit (18 Oct, rework 2): a stint that starts while the lead is
 * Hot is timed against hot_owner_first_attempt (4 working hours), every other
 * stint against nonhot_owner_first_attempt (1 working day). Such a stint gets
 * no separate hot_owner clock (it would count the same miss twice); hot_owner
 * clocks are the ones a lead turning Hot under its owner starts, and only when
 * that owner had not yet called or visited it (rework 3).
 *
 * Attempt = a human call (any outcome) or a visit that happened (visited /
 * no_show). Contact = a connected call or a visit marked visited.
 *
 * Limit: the one in force on the IST day the clock started. Passed when no
 * attempt came by the due moment while the clock was still running; the
 * moment it fell due is the "Limit passed" event. A stint handed to another
 * owner before its limit fell due never passes.
 *
 * Who a miss is charged to (ID 86, 15 Oct): the owner AT THE MOMENT the limit
 * fell due, never whoever holds the lead now. Owner changes are recorded only
 * from OWNER_HISTORY_FROM (E-295); a clock charged to an inferred stint, or
 * that fell due before that day, is flagged owner_inferred and left out of
 * every per-person figure.
 *
 * Holidays: a holiday counts for a clock only if it was on the calendar when
 * the clock stopped (its first attempt, its end, or now). Adding a past
 * holiday therefore moves no finished clock (ID 85 item 7).
 */
import {
    addWorkingMinutes,
    calendarDaysDueAt,
    isWorkingDay,
    istDay,
    workingDaysDueAt,
    workingMinutesBetween,
    type OfficeHoursArg,
} from "@/lib/calendar/officeCalendar";
import { timeLimitDef, type TimeLimitKey, type TimeLimits } from "@/lib/timeLimits/registry";

export type ClockKind =
    | "lead"
    | "owner"
    | "transfer"
    | "hot_assign"
    | "hot_owner"
    | "retry"
    | "quote"
    | "ready_assign"
    | "quote_deliver"
    | "quote_revise";

/** The kinds before E-350; the newer ones need its wider CHECK on lead_clocks.clock. */
export const BASE_CLOCK_KINDS: readonly ClockKind[] = ["lead", "owner", "transfer"];
/** The kinds E-350 allows. */
export const E350_CLOCK_KINDS: readonly ClockKind[] = ["lead", "owner", "transfer", "hot_assign", "hot_owner", "retry", "quote"];
/** Every kind (E-355 widens lead_clocks' CHECK and both clock columns to these). */
export const ALL_CLOCK_KINDS: readonly ClockKind[] = [...E350_CLOCK_KINDS, "ready_assign", "quote_deliver", "quote_revise"];

/** Owner changes are recorded from this IST day (E-295); earlier owners are inferred. */
export const OWNER_HISTORY_FROM = "2026-09-10";

export type ClockLead = {
    id: string;
    created_at: Date;
    sales_ready_at: Date | null;
    assigned_at: Date | null;
    current_owner_id: string | null;
};

/** A call or a visit on a lead. */
export type ClockTouch = {
    lead_id: string;
    at: Date;
    by: string | null;
    kind: "call" | "visit";
    /** It happened (a call, a visit made or a no-show). */
    attempt: boolean;
    /** It reached the dealer (a connected call, a visit marked visited). */
    contact: boolean;
};

export type OwnerHop = { lead_id: string; at: Date; owner_id: string };
export type StatusChange = { lead_id: string; at: Date; to_status: string };

/** A move of the lead's interest level (hot / warm / cold). */
export type InterestChange = { lead_id: string; at: Date; to: string };

/** A quote that went to the CEO queue (manual approval). */
export type QuoteGate = {
    lead_id: string;
    submitted_at: Date;
    decided_at: Date | null;
    withdrawn_at: Date | null;
    decided_by: string | null;
};

/**
 * Holidays for a clock: a fixed set, or a function giving the set that was on
 * the calendar at a moment (holidaysAsOf in calendar/holidays.ts).
 */
export type HolidaysFor = ReadonlySet<string> | ((at: Date) => ReadonlySet<string>);

/** A quote version on the lead, for the delivery and decline clocks (18 Oct, #5). */
export type QuoteVersion = {
    lead_id: string;
    created_at: Date;
    /** When it was approved (by the CEO or the price check); null = not approved. */
    approved_at: Date | null;
    /** First successful send of the quotation. */
    delivered_at: Date | null;
    /** The dealer's answer and when. */
    dealer_decision: string | null;
    dealer_decision_at: Date | null;
    withdrawn_at: Date | null;
};

export type ClockExtras = {
    /** This lead's interest-level changes, by time. */
    interest?: readonly InterestChange[];
    /** This lead's quotes that went to the CEO. */
    quotes?: readonly QuoteGate[];
    /** This lead's quote versions, by created_at (delivery / decline clocks). */
    quoteVersions?: readonly QuoteVersion[];
    /** Kinds to compute; default all. Without E-350 the refresh asks for BASE_CLOCK_KINDS. */
    kinds?: ReadonlySet<ClockKind>;
    /** Office hours (ID 85 #8, officeHoursResolver()); default Mon–Sat 10–19. */
    hours?: OfficeHoursArg;
};

/** Retry clocks end when the lead closes. */
const CLOSED_STATUSES = new Set(["Converted", "Lost"]);

export type LeadClock = {
    dealer_lead_id: string;
    clock: ClockKind;
    owner_id: string | null;
    owner_inferred: boolean;
    start_inferred: boolean;
    started_at: Date;
    ended_at: Date | null;
    first_attempt_at: Date | null;
    first_attempt_kind: "call" | "visit" | null;
    first_contact_at: Date | null;
    attempt_working_minutes: number | null;
    contact_working_minutes: number | null;
    limit_key: TimeLimitKey | null;
    limit_value: number | null;
    due_at: Date | null;
    limit_passed_at: Date | null;
};

const LIMIT_OF: Record<ClockKind, TimeLimitKey> = {
    lead: "lead_first_attempt",
    owner: "owner_first_attempt",
    transfer: "asm_transfer_first_visit",
    hot_assign: "hot_ready_to_assigned",
    hot_owner: "hot_owner_first_attempt",
    retry: "retry_gap",
    quote: "ceo_quote_approval",
    ready_assign: "ready_to_assigned",
    quote_deliver: "quote_approved_not_delivered",
    quote_revise: "quote_declined_not_revised",
};

/**
 * IST day the Hot / non-Hot owner limits took over (22 Oct rework, ID 85 #3).
 * An owner stint that started before it is timed by the old owner limit
 * (owner_first_attempt, 4 working hours), so those clocks agree with the
 * "Limit passed" records already written under it.
 */
export const OWNER_SPLIT_FROM = "2026-10-21";

/**
 * The limit that times a clock kind. The owner clock's depends on when the
 * stint started (`startDay`, IST) and on the lead being Hot then (rework 2).
 */
export function clockLimitKey(kind: ClockKind, hotAtStart = false, startDay?: string): TimeLimitKey {
    if (kind === "owner") {
        if (startDay && startDay < OWNER_SPLIT_FROM) return "owner_first_attempt";
        return hotAtStart ? "hot_owner_first_attempt" : "nonhot_owner_first_attempt";
    }
    return LIMIT_OF[kind];
}

const IST_MS = 330 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * When a working_day_close limit of `n` falls due: the end (23:59:59.999 IST)
 * of the n-th working day, counting the start's own IST day when it is a
 * working day. 1 = the same working day; a start on a holiday or a day off
 * counts from the next working day.
 */
export function workingDayCloseDueAt(start: Date, n: number, holidays: ReadonlySet<string>, hours?: OfficeHoursArg): Date | null {
    const k = Math.max(1, Math.round(n));
    const day = istDay(start);
    if (isWorkingDay(day, holidays, hours)) {
        if (k === 1) return new Date(Date.parse(`${day}T00:00:00Z`) + DAY - 1 - IST_MS);
        return workingDaysDueAt(start, k - 1, holidays, hours);
    }
    return workingDaysDueAt(start, k, holidays, hours);
}

/** When a limit of `value` (in `key`'s unit) that started at `start` falls due. */
export function dueAt(start: Date, key: TimeLimitKey, value: number, holidays: ReadonlySet<string>, hours?: OfficeHoursArg): Date | null {
    const unit = timeLimitDef(key)?.unit;
    if (unit === "working_hours") return addWorkingMinutes(start, value * 60, holidays, hours);
    if (unit === "working_days") return workingDaysDueAt(start, value, holidays, hours);
    if (unit === "working_day_close") return workingDayCloseDueAt(start, value, holidays, hours);
    if (unit === "days") return calendarDaysDueAt(start, value);
    return null;
}

const holidaySet = (h: HolidaysFor, at: Date): ReadonlySet<string> => (typeof h === "function" ? h(at) : h);

const TRANSFER_WINDOW_MS = 10 * 60 * 1000;

type ClockBase = Omit<LeadClock, "attempt_working_minutes" | "contact_working_minutes" | "limit_key" | "limit_value" | "due_at" | "limit_passed_at">;

function finishWith(
    base: ClockBase,
    limitsOn: (day: string) => TimeLimits,
    holidaysFor: HolidaysFor,
    now: Date,
    noLimit: boolean,
    hours: OfficeHoursArg | undefined,
    limitKey?: TimeLimitKey,
): LeadClock {
    const key = noLimit ? null : (limitKey ?? LIMIT_OF[base.clock]);
    const value = key ? limitsOn(istDay(base.started_at))[key] : null;
    // The clock stops at the first attempt, the end of the stint, or now; the
    // holidays are the ones that were on the calendar at that moment.
    const stop = base.first_attempt_at ?? (base.ended_at && base.ended_at < now ? base.ended_at : now);
    const holidays = holidaySet(holidaysFor, stop);
    const due = key && value != null ? dueAt(base.started_at, key, value, holidays, hours) : null;
    const passed = due != null && stop > due ? due : null;
    return {
        ...base,
        attempt_working_minutes: base.first_attempt_at ? workingMinutesBetween(base.started_at, base.first_attempt_at, holidays, hours) : null,
        contact_working_minutes: base.first_contact_at ? workingMinutesBetween(base.started_at, base.first_contact_at, holidays, hours) : null,
        limit_key: key,
        limit_value: value,
        due_at: due,
        limit_passed_at: passed,
    };
}

/** First touch in [from, to) passing `ok`, by time. `touches` is sorted by time. */
function firstTouch(touches: readonly ClockTouch[], from: Date, to: Date | null, ok: (t: ClockTouch) => boolean): ClockTouch | null {
    for (const t of touches) {
        if (t.at < from) continue;
        if (to && t.at >= to) break;
        if (ok(t)) return t;
    }
    return null;
}

type Stint = { at: Date; owner: string; inferred: boolean };

/** The stint holding the lead at `at` (the last one started on or before it). */
function stintAt(stints: readonly Stint[], at: Date): Stint | null {
    for (let i = stints.length - 1; i >= 0; i--) if (stints[i].at <= at) return stints[i];
    return null;
}

/** The owner a clock is charged to: whoever held the lead when it fell due (or stopped, if it never did). */
function chargeTo(stints: readonly Stint[], c: LeadClock, now: Date): Pick<LeadClock, "owner_id" | "owner_inferred"> {
    const at = c.limit_passed_at ?? c.first_attempt_at ?? (c.ended_at && c.ended_at < now ? c.ended_at : now);
    const s = stintAt(stints, at);
    if (!s) return { owner_id: null, owner_inferred: false };
    return { owner_id: s.owner, owner_inferred: s.inferred || istDay(at) < OWNER_HISTORY_FROM };
}

/** Hot spans [from, to) from the interest history (sorted by time); `to` null = still Hot. */
export function hotSpans(changes: readonly InterestChange[]): Array<{ from: Date; to: Date | null }> {
    const out: Array<{ from: Date; to: Date | null }> = [];
    let open: Date | null = null;
    for (const c of changes) {
        const hot = c.to?.toLowerCase() === "hot";
        if (hot && !open) open = c.at;
        else if (!hot && open) {
            out.push({ from: open, to: c.at });
            open = null;
        }
    }
    if (open) out.push({ from: open, to: null });
    return out;
}

const later = (a: Date, b: Date) => (a > b ? a : b);
const earlier = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));

/**
 * Every clock for one lead. `touches`, `hops`, `statuses` and the extras'
 * `interest` belong to this lead and are sorted by time.
 */
export function clocksForLead(
    lead: ClockLead,
    touches: readonly ClockTouch[],
    hops: readonly OwnerHop[],
    statuses: readonly StatusChange[],
    limitsOn: (day: string) => TimeLimits,
    holidays: HolidaysFor,
    now: Date,
    extras: ClockExtras = {},
): LeadClock[] {
    const out: LeadClock[] = [];
    const want = (k: ClockKind) => !extras.kinds || extras.kinds.has(k);
    // Every clock below is timed on the same office hours.
    const finish = (base: ClockBase, l: typeof limitsOn, h: HolidaysFor, n: Date, noLimit = false, limitKey?: TimeLimitKey) =>
        finishWith(base, l, h, n, noLimit, extras.hours, limitKey);
    const spans = hotSpans(extras.interest ?? []);
    const hotAt = (at: Date) => spans.some((sp) => sp.from <= at && (!sp.to || at < sp.to));

    // Owner stints: every recorded assignment, plus an inferred one when the
    // current owner never got an assignment row (or got the lead after it).
    const stints: Stint[] = hops.map((h) => ({ at: h.at, owner: h.owner_id, inferred: false }));
    const last = stints[stints.length - 1];
    if (lead.current_owner_id && (!last || last.owner !== lead.current_owner_id)) {
        const at = lead.assigned_at ?? lead.sales_ready_at ?? lead.created_at;
        if (!last || at > last.at) stints.push({ at, owner: lead.current_owner_id, inferred: true });
    }
    const transfers = statuses.filter((st) => st.to_status === "Transferred_to_ASM");
    const viaTransfer = (at: Date) => transfers.some((t) => Math.abs(t.at.getTime() - at.getTime()) <= TRANSFER_WINDOW_MS);

    if (want("owner")) {
        stints.forEach((s, i) => {
            const end = stints[i + 1]?.at ?? null;
            const mine = (t: ClockTouch) => t.by === s.owner;
            const attempt = firstTouch(touches, s.at, end, (t) => t.attempt && mine(t));
            const contact = firstTouch(touches, s.at, end, (t) => t.contact && mine(t));
            out.push(
                finish(
                    {
                        dealer_lead_id: lead.id,
                        clock: "owner",
                        owner_id: s.owner,
                        owner_inferred: s.inferred || istDay(s.at) < OWNER_HISTORY_FROM,
                        start_inferred: false,
                        started_at: s.at,
                        ended_at: end,
                        first_attempt_at: attempt?.at ?? null,
                        first_attempt_kind: attempt?.kind ?? null,
                        first_contact_at: contact?.at ?? null,
                    },
                    limitsOn,
                    holidays,
                    now,
                    viaTransfer(s.at),
                    // Rework 2: Hot when the stint started → the Hot limit, else the non-Hot one;
                    // a stint before 21 Oct keeps the old owner limit (ID 85 #3).
                    clockLimitKey("owner", hotAt(s.at), istDay(s.at)),
                ),
            );
        });
    }

    // Lead clock: from sales-ready, else (inferred) from the first assignment.
    // 22 Oct rework (ID 85 #1/#2): a team figure only, never charged to a
    // person. Its 4 working hours fell on non-Hot owners who were inside their
    // own 1-working-day owner clock; owners are judged by the owner clocks.
    const leadStart = lead.sales_ready_at ?? stints[0]?.at ?? null;
    if (leadStart && want("lead")) {
        const attempt = firstTouch(touches, leadStart, null, (t) => t.attempt);
        const contact = firstTouch(touches, leadStart, null, (t) => t.contact);
        const c = finish(
            {
                dealer_lead_id: lead.id,
                clock: "lead",
                owner_id: null,
                owner_inferred: false,
                start_inferred: !lead.sales_ready_at,
                started_at: leadStart,
                ended_at: null,
                first_attempt_at: attempt?.at ?? null,
                first_attempt_kind: attempt?.kind ?? null,
                first_contact_at: contact?.at ?? null,
            },
            limitsOn,
            holidays,
            now,
        );
        out.push(c);
    }

    // Transfer clocks: each move to Transferred_to_ASM until the next status change.
    if (want("transfer")) {
        statuses.forEach((st, i) => {
            if (st.to_status !== "Transferred_to_ASM") return;
            const end = statuses[i + 1]?.at ?? null;
            const visit = firstTouch(touches, st.at, end, (t) => t.kind === "visit" && t.contact);
            const c = finish(
                {
                    dealer_lead_id: lead.id,
                    clock: "transfer",
                    owner_id: null,
                    owner_inferred: false,
                    start_inferred: false,
                    started_at: st.at,
                    ended_at: end,
                    first_attempt_at: visit?.at ?? null,
                    first_attempt_kind: visit ? "visit" : null,
                    first_contact_at: visit?.at ?? null,
                },
                limitsOn,
                holidays,
                now,
            );
            out.push({ ...c, ...chargeTo(stints, c, now) });
        });
    }

    // Ready → assigned for leads that are not Hot (18 Oct, rework 1): over each
    // non-Hot span from sales-ready, while nobody holds the lead.
    if (want("ready_assign") && lead.sales_ready_at) {
        for (const span of nonHotSpans(spans, lead.sales_ready_at)) {
            const start = span.from;
            if (stintAt(stints, start)) break;
            const assigned = stints.find((s) => s.at >= start) ?? null;
            const assignedInSpan = assigned && (!span.to || assigned.at < span.to) ? assigned : null;
            out.push(
                finish(
                    {
                        dealer_lead_id: lead.id,
                        clock: "ready_assign",
                        owner_id: null,
                        owner_inferred: false,
                        start_inferred: false,
                        started_at: start,
                        ended_at: assignedInSpan ? null : span.to,
                        first_attempt_at: assignedInSpan?.at ?? null,
                        first_attempt_kind: null,
                        first_contact_at: null,
                    },
                    limitsOn,
                    holidays,
                    now,
                ),
            );
            // Once assigned, later non-Hot spans are not waiting for an owner.
            if (assignedInSpan) break;
        }
    }

    // Hot clocks (15 Oct).
    for (const span of spans) {
        // Ready → assigned: only while the lead is sales-ready and has no owner.
        if (want("hot_assign") && lead.sales_ready_at) {
            const start = later(span.from, lead.sales_ready_at);
            if (!stintAt(stints, start) && (!span.to || start < span.to)) {
                const assigned = stints.find((s) => s.at >= start) ?? null;
                const assignedInSpan = assigned && (!span.to || assigned.at < span.to) ? assigned : null;
                out.push(
                    finish(
                        {
                            dealer_lead_id: lead.id,
                            clock: "hot_assign",
                            owner_id: null,
                            owner_inferred: false,
                            start_inferred: false,
                            started_at: start,
                            ended_at: assignedInSpan ? null : span.to,
                            first_attempt_at: assignedInSpan?.at ?? null,
                            first_attempt_kind: null,
                            first_contact_at: null,
                        },
                        limitsOn,
                        holidays,
                        now,
                    ),
                );
            }
        }
        // A fresh owner clock for every stint the Hot span overlaps.
        if (want("hot_owner")) {
            stints.forEach((s, i) => {
                const stintEnd = stints[i + 1]?.at ?? null;
                const start = later(span.from, s.at);
                if ((stintEnd && start >= stintEnd) || (span.to && start >= span.to)) return;
                // Rework 2: a stint that started Hot is timed by its owner clock (Hot limit).
                if (start.getTime() === s.at.getTime()) return;
                const end = earlier(stintEnd, span.to);
                const mine = (t: ClockTouch) => t.by === s.owner;
                // Rework 3: the owner already called or visited before the lead turned Hot.
                if (firstTouch(touches, s.at, start, (t) => t.attempt && mine(t))) return;
                const attempt = firstTouch(touches, start, end, (t) => t.attempt && mine(t));
                const contact = firstTouch(touches, start, end, (t) => t.contact && mine(t));
                out.push(
                    finish(
                        {
                            dealer_lead_id: lead.id,
                            clock: "hot_owner",
                            owner_id: s.owner,
                            owner_inferred: s.inferred || istDay(start) < OWNER_HISTORY_FROM,
                            start_inferred: false,
                            started_at: start,
                            ended_at: end,
                            first_attempt_at: attempt?.at ?? null,
                            first_attempt_kind: attempt?.kind ?? null,
                            first_contact_at: contact?.at ?? null,
                        },
                        limitsOn,
                        holidays,
                        now,
                    ),
                );
            });
        }
    }

    // Retry clocks: each unanswered call, up to retry_max_attempts in a row.
    if (want("retry")) {
        let streak = 0;
        touches.forEach((t, i) => {
            if (t.contact) {
                streak = 0;
                return;
            }
            if (t.kind !== "call" || !t.attempt) return;
            streak++;
            if (streak > limitsOn(istDay(t.at)).retry_max_attempts) return;
            const closedAt = statuses.find((st) => st.at > t.at && CLOSED_STATUSES.has(st.to_status))?.at ?? null;
            let next: ClockTouch | null = null;
            for (let j = i + 1; j < touches.length; j++) {
                const x = touches[j];
                if (closedAt && x.at >= closedAt) break;
                if (x.attempt && x.at > t.at) {
                    next = x;
                    break;
                }
            }
            const c = finish(
                {
                    dealer_lead_id: lead.id,
                    clock: "retry",
                    owner_id: null,
                    owner_inferred: false,
                    start_inferred: false,
                    started_at: t.at,
                    ended_at: next ? null : closedAt,
                    first_attempt_at: next?.at ?? null,
                    first_attempt_kind: next?.kind ?? null,
                    first_contact_at: next?.contact ? next.at : null,
                },
                limitsOn,
                holidays,
                now,
            );
            out.push({ ...c, ...chargeTo(stints, c, now) });
        });
    }

    // Quote approval clocks: charged to whoever decided, else nobody.
    if (want("quote")) {
        for (const q of extras.quotes ?? []) {
            out.push(
                finish(
                    {
                        dealer_lead_id: lead.id,
                        clock: "quote",
                        owner_id: q.decided_by,
                        owner_inferred: false,
                        start_inferred: false,
                        started_at: q.submitted_at,
                        ended_at: q.decided_at ? null : q.withdrawn_at,
                        first_attempt_at: q.decided_at,
                        first_attempt_kind: null,
                        first_contact_at: q.decided_at,
                    },
                    limitsOn,
                    holidays,
                    now,
                ),
            );
        }
    }

    // Quote delivery and decline clocks (18 Oct, #5), charged to the owner when due.
    const versions = extras.quoteVersions ?? [];
    if (want("quote_deliver") || want("quote_revise")) {
        const statusAfter = (after: Date, ok: (s: string) => boolean) => statuses.find((st) => st.at > after && ok(st.to_status))?.at ?? null;
        versions.forEach((q, i) => {
            const next = versions.slice(i + 1).find((v) => v.created_at > q.created_at)?.created_at ?? null;
            if (want("quote_deliver") && q.approved_at) {
                const delivered = q.delivered_at && q.delivered_at >= q.approved_at && (!next || q.delivered_at < next) ? q.delivered_at : null;
                const c = finish(
                    {
                        dealer_lead_id: lead.id,
                        clock: "quote_deliver",
                        owner_id: null,
                        owner_inferred: false,
                        start_inferred: false,
                        started_at: q.approved_at,
                        ended_at: delivered ? null : earlier(earlier(q.withdrawn_at, next), statusAfter(q.approved_at, (s) => CLOSED_STATUSES.has(s))),
                        first_attempt_at: delivered,
                        first_attempt_kind: null,
                        first_contact_at: delivered,
                    },
                    limitsOn,
                    holidays,
                    now,
                );
                out.push({ ...c, ...chargeTo(stints, c, now) });
            }
            if (want("quote_revise") && q.dealer_decision === "declined" && q.dealer_decision_at) {
                const at = q.dealer_decision_at;
                const revised = versions.find((v) => v.created_at > at)?.created_at ?? null;
                const answered = earlier(revised, statusAfter(at, (s) => s === "Lost"));
                const c = finish(
                    {
                        dealer_lead_id: lead.id,
                        clock: "quote_revise",
                        owner_id: null,
                        owner_inferred: false,
                        start_inferred: false,
                        started_at: at,
                        ended_at: answered ? null : statusAfter(at, (s) => CLOSED_STATUSES.has(s)),
                        first_attempt_at: answered,
                        first_attempt_kind: null,
                        first_contact_at: answered,
                    },
                    limitsOn,
                    holidays,
                    now,
                );
                out.push({ ...c, ...chargeTo(stints, c, now) });
            }
        });
    }

    return out;
}

/**
 * The non-Hot spans [from, to) at or after `from` — the gaps between the Hot
 * spans (sorted by time); `to` null = open.
 */
export function nonHotSpans(hot: ReadonlyArray<{ from: Date; to: Date | null }>, from: Date): Array<{ from: Date; to: Date | null }> {
    const out: Array<{ from: Date; to: Date | null }> = [];
    let cur: Date | null = from;
    for (const h of hot) {
        if (!cur) break;
        if (h.to && h.to <= cur) continue;
        if (h.from > cur) out.push({ from: cur, to: h.from });
        cur = h.to;
    }
    if (cur) out.push({ from: cur, to: null });
    return out;
}

/** Median and the slowest 1 in 10 (90th percentile, nearest rank) of a list. */
export function medianAndP90(values: readonly number[]): { median: number | null; p90: number | null } {
    if (!values.length) return { median: null, p90: null };
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    const p90 = v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)];
    return { median, p90 };
}
