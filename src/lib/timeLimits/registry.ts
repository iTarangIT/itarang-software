/**
 * Every time limit in the lead module, in one list (tracker ID 85).
 *
 * CLIENT-SAFE — no db import: the settings screen, the change log and the
 * server all read the same definitions. The values live in
 * time_limit_settings (E-337), dated: a change takes effect on its
 * effective_from day, earlier days keep the value they had. No row = the
 * default below, which is what the code used before ID 85.
 *
 * Units, all on the office calendar (src/lib/calendar/officeCalendar.ts):
 *   working_hours  Mon–Sat 10:00–19:00 IST, holidays off
 *   working_days   Mon–Sat, holidays off
 *   working_day_close  by the close of the Nth working day, counting the
 *                  start's own day when it is a working day: 1 = "the same
 *                  working day" (18 Oct, #5)
 *   days           calendar days
 *   count          a number of things, not a time (retry attempts)
 *
 * TO ADD A LIMIT: a row here, then read it with getTimeLimits() where the old
 * constant was. The settings screen and the log pick it up.
 */

export type LimitUnit = "working_hours" | "working_days" | "working_day_close" | "days" | "count";

export type TimeLimitDef = {
    key: string;
    group: "Lead clocks" | "Follow-up" | "Quotes" | "Onboarding" | "Invoices";
    label: string;
    unit: LimitUnit;
    default: number;
    min: number;
    max: number;
    /** What the limit decides, and where it shows. */
    help: string;
    /**
     * IST day from which the limit no longer times anything new (22 Oct
     * rework, ID 85 #3). A retired limit keeps its dated values for what it
     * timed before that day, but is not shown on the settings page and cannot
     * be changed.
     */
    retiredOn?: string;
};

export const TIME_LIMITS = [
    // ── ID 86 clocks ──────────────────────────────────────────────────────────
    {
        key: "lead_first_attempt",
        group: "Lead clocks",
        label: "Lead: first call or visit after it becomes sales-ready",
        unit: "working_hours",
        default: 4,
        min: 1,
        max: 72,
        help: "Lead clock. Passed = a 'Limit passed' event; the daily email's Time limits missed.",
    },
    {
        key: "owner_first_attempt",
        group: "Lead clocks",
        label: "New owner: first call or visit after the lead is assigned (until 21 Oct 2026)",
        unit: "working_hours",
        default: 4,
        min: 1,
        max: 72,
        help: "Times every hand-over made before 21 Oct 2026, so those owner clocks agree with the misses already recorded. From 21 Oct a Hot lead's owner has the Hot limit and every other owner has 'Non-Hot lead: owner's first call or visit'.",
        retiredOn: "2026-10-21",
    },
    {
        key: "nonhot_owner_first_attempt",
        group: "Lead clocks",
        label: "Non-Hot lead: owner's first call or visit after the lead is assigned",
        unit: "working_days",
        default: 1,
        min: 1,
        max: 30,
        help: "Owner clock, every assignment of a lead that is not Hot at that moment (Hot leads: the Hot limit). The daily email's First attempt within limit.",
    },
    {
        key: "asm_transfer_first_visit",
        group: "Lead clocks",
        label: "ASM: first visit after Transfer to ASM",
        unit: "working_days",
        default: 3,
        min: 1,
        max: 30,
        help: "Awaiting field visit overdue (admin alert panel, needs attention, Sales Head actions).",
    },
    // ── Hot leads (15 Oct rework) ─────────────────────────────────────────────
    {
        key: "hot_ready_to_assigned",
        group: "Lead clocks",
        label: "Hot lead: sales-ready to having an owner",
        unit: "working_hours",
        default: 9,
        min: 1,
        max: 72,
        help: "Hot clock 'Ready → assigned'. A Hot lead with no owner after this is a 'Limit passed'; other leads have 'Non-Hot lead: sales-ready to having an owner'.",
    },
    {
        key: "ready_to_assigned",
        group: "Lead clocks",
        label: "Non-Hot lead: sales-ready to having an owner",
        unit: "working_days",
        default: 2,
        min: 1,
        max: 30,
        help: "Clock 'Ready → assigned' for leads that are not Hot (18 Oct rework). Passed = a 'Limit passed' record; the CEO card, Ready to assign and the daily email's Right now box count against it.",
    },
    {
        key: "hot_owner_first_attempt",
        group: "Lead clocks",
        label: "Hot lead: owner's first call or visit after it turns Hot (or reaches them Hot)",
        unit: "working_hours",
        default: 4,
        min: 1,
        max: 72,
        help: "The owner clock of a lead assigned while Hot, and a fresh clock when a lead turns Hot under an owner who has not called or visited it yet.",
    },
    // ── Retries ───────────────────────────────────────────────────────────────
    {
        key: "retry_gap",
        group: "Lead clocks",
        label: "Unanswered call: next attempt within",
        unit: "working_hours",
        default: 9,
        min: 1,
        max: 72,
        help: "Retry clock: from a call that did not connect to the next call or visit by anyone.",
    },
    {
        key: "retry_max_attempts",
        group: "Lead clocks",
        label: "Unanswered calls in a row that are retried on the clock",
        unit: "count",
        default: 3,
        min: 1,
        max: 10,
        help: "After this many unanswered calls in a row, the next retry is no longer timed.",
    },
    // ── Follow-up ─────────────────────────────────────────────────────────────
    {
        key: "quote_no_answer",
        group: "Follow-up",
        label: "Quote sent, no answer from the dealer",
        unit: "working_days",
        default: 3,
        min: 1,
        max: 30,
        help: "Sales Head actions: Quotes with no answer.",
    },
    {
        key: "ceo_quote_approval",
        group: "Quotes",
        label: "CEO: approve or reject a quote sent for approval",
        unit: "working_hours",
        default: 4,
        min: 1,
        max: 72,
        help: "Quote approval clock, from the quote reaching the CEO queue to the decision. Auto-approved quotes are not timed.",
    },
    {
        key: "quote_approved_not_delivered",
        group: "Quotes",
        label: "Approved quote: sent to the dealer",
        unit: "working_day_close",
        default: 1,
        min: 1,
        max: 10,
        help: "Clock 'Approved quote not delivered': from the approval to the first successful send of the quotation. 1 = the same working day.",
    },
    {
        key: "quote_declined_not_revised",
        group: "Quotes",
        label: "Dealer declined a quote: revised or marked Lost",
        unit: "working_days",
        default: 2,
        min: 1,
        max: 30,
        help: "Clock 'Dealer declined, not revised or marked Lost': from the dealer's decline to a new quote version or the lead marked Lost.",
    },
    {
        key: "said_yes_not_won",
        group: "Follow-up",
        label: "Dealer said yes, lead not marked Won",
        unit: "working_days",
        default: 1,
        min: 1,
        max: 30,
        help: "CEO and Sales Head cards, and the admin alert panel.",
    },
    {
        key: "sales_ready_unassigned",
        group: "Follow-up",
        label: "Sales-ready lead waiting for an owner (until 21 Oct 2026)",
        unit: "days",
        default: 7,
        min: 1,
        max: 60,
        help: "Kept for the record of what was in force before the 18 Oct rework. Nothing counts against it now: non-Hot leads use 'Non-Hot lead: sales-ready to having an owner', Hot leads the Hot limit.",
        retiredOn: "2026-10-21",
    },
    {
        key: "idle_cc",
        group: "Follow-up",
        label: "No work on a lead held by inside sales",
        unit: "working_days",
        default: 5,
        min: 1,
        max: 60,
        help: "Needs attention list, inside-sales holders.",
    },
    {
        key: "idle_asm",
        group: "Follow-up",
        label: "No work on a lead held by an ASM",
        unit: "working_days",
        default: 7,
        min: 1,
        max: 60,
        help: "Needs attention list, ASM holders.",
    },
    {
        key: "stale_yellow",
        group: "Follow-up",
        label: "No touch: first warning (inside sales)",
        unit: "working_days",
        default: 5,
        min: 1,
        max: 60,
        help: "Leads held by inside sales and everyone but ASMs. Yellow cue on lead rows; admin alert 'no touch'. Must be below the red warning.",
    },
    {
        key: "stale_red",
        group: "Follow-up",
        label: "No touch: red warning (inside sales)",
        unit: "working_days",
        default: 10,
        min: 2,
        max: 90,
        help: "Leads held by inside sales and everyone but ASMs. Red cue on lead rows; admin alert 'no touch'. Must be below the critical warning.",
    },
    {
        key: "stale_critical",
        group: "Follow-up",
        label: "Awaiting a decision: critical (inside sales)",
        unit: "working_days",
        default: 14,
        min: 3,
        max: 120,
        help: "Leads held by inside sales and everyone but ASMs. Critical cue on lead rows; admin alert 'awaiting decision'.",
    },
    // ID 85 #5 (22 Oct): the same three warnings for leads an ASM holds.
    {
        key: "stale_yellow_asm",
        group: "Follow-up",
        label: "No touch: first warning (ASM)",
        unit: "working_days",
        default: 5,
        min: 1,
        max: 60,
        help: "Leads held by an ASM. Yellow cue on lead rows; admin alert 'no touch'. Must be below the ASM red warning.",
    },
    {
        key: "stale_red_asm",
        group: "Follow-up",
        label: "No touch: red warning (ASM)",
        unit: "working_days",
        default: 10,
        min: 2,
        max: 90,
        help: "Leads held by an ASM. Red cue on lead rows; admin alert 'no touch'. Must be below the ASM critical warning.",
    },
    {
        key: "stale_critical_asm",
        group: "Follow-up",
        label: "Awaiting a decision: critical (ASM)",
        unit: "working_days",
        default: 14,
        min: 3,
        max: 120,
        help: "Leads held by an ASM. Critical cue on lead rows; admin alert 'awaiting decision'.",
    },
    {
        key: "won_not_converted",
        group: "Follow-up",
        label: "Marked Won, not yet converted",
        unit: "days",
        default: 3,
        min: 1,
        max: 60,
        help: "Admin dashboard: stale Won leads.",
    },
    // ── Onboarding ────────────────────────────────────────────────────────────
    {
        key: "onboarding_dropout",
        group: "Onboarding",
        label: "Onboarding drop-out: days since the last action on the form, by anyone",
        unit: "days",
        default: 21,
        min: 7,
        max: 120,
        help: "Admin › Onboarding drop-outs review.",
    },
    {
        key: "onboarding_keep_waiting",
        group: "Onboarding",
        label: "Drop-out 'Keep waiting' parks the lead for",
        unit: "days",
        default: 21,
        min: 1,
        max: 120,
        help: "Resolve a drop-out → Keep waiting.",
    },
    {
        key: "onboarding_stall_dealer",
        group: "Onboarding",
        label: "Onboarding stalled on the dealer's side",
        unit: "days",
        default: 7,
        min: 1,
        max: 60,
        help: "Onboarding stalled card (waiting on the dealer).",
    },
    {
        key: "onboarding_stall_us",
        group: "Onboarding",
        label: "Onboarding stalled on our side",
        unit: "working_days",
        default: 2,
        min: 1,
        max: 30,
        help: "Onboarding stalled card (waiting on us).",
    },
    // ── ID 171 ────────────────────────────────────────────────────────────────
    {
        key: "invoice_stale_days",
        group: "Invoices",
        label: "No new invoice read",
        unit: "working_days",
        default: 3,
        min: 1,
        max: 15,
        help: "Admin bell + a line in the daily Sales email; 'Invoices read up to' turns amber under revenue and battery numbers.",
    },
] as const satisfies readonly TimeLimitDef[];

export type TimeLimitKey = (typeof TIME_LIMITS)[number]["key"];
export type TimeLimits = Record<TimeLimitKey, number>;

const BY_KEY = new Map<string, TimeLimitDef>(TIME_LIMITS.map((d) => [d.key, d]));

export function timeLimitDef(key: string): TimeLimitDef | undefined {
    return BY_KEY.get(key);
}

/** A limit retired from the settings page (ID 85 #3); still resolves for what it timed before. */
export function isRetiredLimit(key: string): boolean {
    return !!BY_KEY.get(key)?.retiredOn;
}

export function isTimeLimitKey(key: unknown): key is TimeLimitKey {
    return typeof key === "string" && BY_KEY.has(key);
}

export const TIME_LIMIT_DEFAULTS = Object.fromEntries(TIME_LIMITS.map((d) => [d.key, d.default])) as TimeLimits;

const UNIT_WORDS: Record<LimitUnit, [string, string]> = {
    working_hours: ["working hour", "working hours"],
    working_days: ["working day", "working days"],
    working_day_close: ["working day", "working days"],
    days: ["day", "days"],
    count: ["", ""],
};

/** "4 working hours", "1 working day", "21 days", "the same working day". */
export function formatLimit(value: number, unit: LimitUnit): string {
    if (unit === "count") return String(value);
    if (unit === "working_day_close") return value <= 1 ? "the same working day" : `${value - 1} working day${value === 2 ? "" : "s"} after`;
    const [one, many] = UNIT_WORDS[unit];
    return `${value} ${value === 1 ? one : many}`;
}

/**
 * Rules that span limits, checked on save with the would-be values: the three
 * no-touch cues must rise, for inside sales and for ASMs. Returns the reason a set of values is refused, or null.
 */
export function crossLimitProblem(v: TimeLimits): string | null {
    if (!(v.stale_yellow < v.stale_red && v.stale_red < v.stale_critical)) {
        return "The no-touch warnings (inside sales) must rise: first warning < red warning < critical.";
    }
    if (!(v.stale_yellow_asm < v.stale_red_asm && v.stale_red_asm < v.stale_critical_asm)) {
        return "The no-touch warnings (ASM) must rise: first warning < red warning < critical.";
    }
    return null;
}
