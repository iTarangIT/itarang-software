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
 *   days           calendar days
 *
 * TO ADD A LIMIT: a row here, then read it with getTimeLimits() where the old
 * constant was. The settings screen and the log pick it up.
 */

export type LimitUnit = "working_hours" | "working_days" | "days";

export type TimeLimitDef = {
    key: string;
    group: "Lead clocks" | "Follow-up" | "Onboarding" | "Invoices";
    label: string;
    unit: LimitUnit;
    default: number;
    min: number;
    max: number;
    /** What the limit decides, and where it shows. */
    help: string;
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
        label: "New owner: first call or visit after the lead is assigned",
        unit: "working_hours",
        default: 4,
        min: 1,
        max: 72,
        help: "Owner clock, every assignment. The daily email's First attempt within limit; Sales Head's Hot leads not called in time.",
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
        label: "Sales-ready lead waiting for an owner",
        unit: "days",
        default: 7,
        min: 1,
        max: 60,
        help: "Ready to assign: overdue count on the CEO card.",
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
        label: "No touch: first warning",
        unit: "working_days",
        default: 5,
        min: 1,
        max: 60,
        help: "Yellow cue on lead rows; admin alert 'no touch'. Must be below the red warning.",
    },
    {
        key: "stale_red",
        group: "Follow-up",
        label: "No touch: red warning",
        unit: "working_days",
        default: 10,
        min: 2,
        max: 90,
        help: "Red cue on lead rows; admin alert 'no touch'. Must be below the critical warning.",
    },
    {
        key: "stale_critical",
        group: "Follow-up",
        label: "Awaiting a decision: critical",
        unit: "working_days",
        default: 14,
        min: 3,
        max: 120,
        help: "Critical cue on lead rows; admin alert 'awaiting decision'.",
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

export function isTimeLimitKey(key: unknown): key is TimeLimitKey {
    return typeof key === "string" && BY_KEY.has(key);
}

export const TIME_LIMIT_DEFAULTS = Object.fromEntries(TIME_LIMITS.map((d) => [d.key, d.default])) as TimeLimits;

const UNIT_WORDS: Record<LimitUnit, [string, string]> = {
    working_hours: ["working hour", "working hours"],
    working_days: ["working day", "working days"],
    days: ["day", "days"],
};

/** "4 working hours", "1 working day", "21 days". */
export function formatLimit(value: number, unit: LimitUnit): string {
    const [one, many] = UNIT_WORDS[unit];
    return `${value} ${value === 1 ? one : many}`;
}

/**
 * Rules that span limits, checked on save with the would-be values: the three
 * no-touch cues must rise. Returns the reason a set of values is refused, or null.
 */
export function crossLimitProblem(v: TimeLimits): string | null {
    if (!(v.stale_yellow < v.stale_red && v.stale_red < v.stale_critical)) {
        return "The no-touch warnings must rise: first warning < red warning < critical.";
    }
    return null;
}
