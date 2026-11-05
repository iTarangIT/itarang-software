// E-315 — the campaign auto-retry policy: WHEN (if ever) to redial a lead.
//
// Pure: no DB, no clock of its own (`now` is passed in), so vitest covers it.
// The single consumer is campaignTracker.recordAttemptOutcome, which every
// outcome writer (webhook/poll finalizers, the advanceCampaign trigger-failure
// branches, the no_webhook sweep) goes through — so this file is the whole
// answer to "why was / wasn't this lead retried, and why at that time".
//
// Before E-315 a campaign dialled each lead exactly once: a busy line was as
// final as a conversation, and campaigns closed at ~9% connected (Hanumangarh,
// 28 Sept: 2 of 23). The manual "Retry unreached" button remains for an extra
// pass after the automatic retries run out.
//
// Retry times are always moved INTO the calling window. For a scheduled
// campaign that is its own window; for schedule_mode='now' (always open) it is
// the org default working hours, so an automatic retry never rings a dealer at
// night even though a manual 'now' campaign may be started at any hour.

import { classifyTriggerDetail, isRetryableFailure } from "./failureReason";
import { DIALER_HOURS } from "@/lib/queue/campaignSchedule";

export type RetryWindow = {
    /** 'HH:MM' IST */
    start: string;
    /** 'HH:MM' IST. Smaller than start = the window wraps midnight. */
    end: string;
    /** ['mon', …]; null/empty = every day. */
    days: readonly string[] | null;
};

export type RetryInput = {
    /** The status this attempt landed in (classifyCallEnd output). */
    status: string;
    /** dialer_campaign_leads.call_outcome for this attempt. */
    callOutcome: string | null;
    /** Dials placed so far INCLUDING the one that just ended. */
    attemptCount: number;
    /** dialer_campaigns.max_retries — null = auto-retry off (pre-E-315 campaigns). */
    maxRetries: number | null;
    now: Date;
    window: RetryWindow;
    /** Retries already granted free because OUR line was blocked (see below). */
    lineBlockedRetriesUsed?: number;
    /**
     * B3 — counted dials of this row on the IST day of `now`, INCLUDING the one
     * that just ended. At MAX_DIALS_PER_DAY the next retry moves to tomorrow.
     */
    dialsToday?: number;
    /**
     * Dispositions v3 — this dial's label (dispositionV3.ts). When set, the
     * sheet's re-attempt rule for it (REATTEMPT_RULES) decides; without it
     * (Bolna, rows from before v3) the old gap tables do.
     */
    disposition?: string | null;
    /**
     * Earlier dials of this row, oldest first, NOT including the one that just
     * ended — for the "once" rules and the 3-day limit on "Did not pick".
     */
    history?: ReadonlyArray<ReattemptHistoryEntry>;
    /** The time the dealer asked to be called (Ask to Call Back), if given. */
    requestedAt?: Date | null;
};

export type ReattemptHistoryEntry = {
    at?: string | null;
    counted?: boolean;
    /** The v3 disposition stored on the attempt_history entry. */
    disp?: string | null;
};

export type RetryPlan = {
    at: Date;
    /** false = this dial never reached the dealer's network; it is refunded. */
    consumesAttempt: boolean;
    /**
     * Set when the sheet's rule outlives the campaign (7 / 30 / 90 days): the
     * row is done, and `at` is when the lead may be AI-dialled again
     * (ai_redial_plan, E-373). The row itself is NOT redialled.
     */
    longHorizon?: { once: boolean };
};

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 'next_window' = the next opening of the calling window after now. */
type Gap = number | "next_window";

// A busy line usually frees up within minutes; the dealer who didn't answer,
// hung up or sat silent is more likely busy with a customer, so give them room.
const BUSY_GAPS: Gap[] = [15 * MIN, HOUR, 3 * HOUR];
const DEFAULT_GAPS: Gap[] = [HOUR, 3 * HOUR, "next_window"];

/** Non-conversation statuses that are always worth another dial. */
const RETRY_STATUSES = new Set([
    "busy",
    "no_response",
    "rejected",
    "voicemail",
    "silent",
    "hung_up",
    "no_conversation",
]);

// Outcomes that no amount of redialling fixes, or that a person chose.
const NEVER_RETRY_OUTCOME = [
    /invalid_number/i,
    /no_phone/i,
    /ineligible/i,
    /stopped_by_user/i,
];

/**
 * call_outcome of a conversation that was cut off before it finished (AI dialer
 * review point 8; callCategory.ts 'disconnected'). The dealer spoke, so the row
 * is 'completed' — but nothing was settled, so it is redialled like a hang-up,
 * within the same max_retries budget.
 */
export const DISCONNECTED_OUTCOME = "disconnected";

export function isAutoRetryable(status: string, callOutcome: string | null): boolean {
    const outcome = callOutcome ?? "";
    if (NEVER_RETRY_OUTCOME.some((re) => re.test(outcome))) return false;
    if (RETRY_STATUSES.has(status)) return true;
    if (status === "completed" && outcome === DISCONNECTED_OUTCOME) return true;
    if (status === "failed") {
        // The watchdog's "we never heard back" — the call may never have rung.
        if (outcome === "no_webhook") return true;
        return isRetryableFailure({ status, callOutcome });
    }
    return false; // completed (a finished conversation), skipped, pending, calling, unknown
}

// ── Line blocked on OUR side ────────────────────────────────────────────────
//
// SIP 403 Forbidden / 401 / 407, a misconfigured from-number, an empty wallet,
// a 429 rate limit: the provider refused to place the call at all. Nothing is
// learned about the dealer, so the dial is refunded instead of burning one of
// the lead's attempts, and the lead waits LINE_BLOCKED_PAUSE for the line to
// come back. Capped, so a line that stays blocked cannot loop a campaign
// forever — past the cap the dial counts like any other failure.
//
// Seen on prod 2026-09-30: every dial from 13:56 came back "sip status: 403:
// Forbidden" and each one spent a lead's last retry.
export const LINE_BLOCKED_PAUSE_MS = 30 * MIN;
export const MAX_LINE_BLOCKED_RETRIES = 10;

export function isLineBlockedFailure(callOutcome: string | null): boolean {
    const outcome = callOutcome ?? "";
    const m = /^trigger_(?:failed|exception):\s*([\s\S]*)$/i.exec(outcome);
    if (!m) return false;
    const detail = m[1].toLowerCase();
    if (/(^|[^0-9])(401|403|407|429)([^0-9]|$)/.test(detail)) return true;
    if (detail.includes("too many requests") || detail.includes("rate limit")) return true;
    return classifyTriggerDetail(detail) === "config_error";
}

// ── D1: pause the campaign when the carrier keeps refusing ──────────────────
//
// The refund above protects the LEAD; nothing protected the CAMPAIGN. A line
// that stays blocked made advanceCampaign fire the next lead at once, up to 100
// per run (690 refused dials on 30 Sep). So line-blocked trigger failures are
// counted in a row per campaign (src/lib/ai-dialer/lineHealth.ts), and at
// CARRIER_PAUSE_THRESHOLD the campaign pauses until someone presses Resume.

export const CARRIER_PAUSE_THRESHOLD = 10;
/** After any failed trigger, wait this long before dialling the next lead. */
export const FAILED_TRIGGER_GAP_MS = 2_000;

/**
 * The line-blocked count after one trigger result. `outcome` is the
 * call_outcome written for a failed trigger, or null when the call was placed.
 * Anything that reached the carrier — a placed call, busy, unanswered, a dead
 * number — resets the run to 0.
 */
export function nextLineBlockedCount(previous: number, outcome: string | null): number {
    return isLineBlockedFailure(outcome) ? previous + 1 : 0;
}

export function shouldPauseForCarrier(consecutiveLineBlocked: number): boolean {
    return consecutiveLineBlocked >= CARRIER_PAUSE_THRESHOLD;
}

// ── B3: at most two dials a day, inside dialler hours ───────────────────────

/** Counted dials of one number per IST day. A third waits for tomorrow. */
export const MAX_DIALS_PER_DAY = 2;

/**
 * A campaign window narrowed to DIALER_HOURS — the JS twin of the clause
 * campaignWindow.windowOpenSql ANDs on. An overnight window, or one with no
 * overlap, has nothing inside dialler hours; it falls back to the dialler hours
 * on the window's days rather than booking a retry the gate will refuse.
 */
export function withinDialerHours(window: RetryWindow): RetryWindow {
    const s = hhmmToMinutes(window.start);
    const e = hhmmToMinutes(window.end);
    const ds = hhmmToMinutes(DIALER_HOURS.start);
    const de = hhmmToMinutes(DIALER_HOURS.end);
    if (e <= s) return { ...window, start: DIALER_HOURS.start, end: DIALER_HOURS.end };
    const start = Math.max(s, ds);
    const end = Math.min(e, de);
    if (end <= start) return { ...window, start: DIALER_HOURS.start, end: DIALER_HOURS.end };
    return { ...window, start: minutesToHhmm(start), end: minutesToHhmm(end) };
}

/** Counted dials in `history` on the IST day of `now` (entries carry ISO `at`). */
export function countDialsOnIstDay(
    history: ReadonlyArray<{ at?: string | null; counted?: boolean }>,
    now: Date,
): number {
    const today = istParts(now).dayIndex;
    return history.filter(
        (h) => h.counted !== false && h.at && istParts(new Date(h.at)).dayIndex === today,
    ).length;
}

/**
 * planRetry plus whether the dial that just ended counts against the lead's
 * attempt budget. null = the lead is done.
 */
export function planRetryDetailed(input: RetryInput): RetryPlan | null {
    const { maxRetries } = input;
    if (maxRetries == null || maxRetries <= 0) return null;
    const window = withinDialerHours(input.window);
    if (
        isLineBlockedFailure(input.callOutcome) &&
        (input.lineBlockedRetriesUsed ?? 0) < MAX_LINE_BLOCKED_RETRIES
    ) {
        return {
            at: clampIntoWindow(new Date(input.now.getTime() + LINE_BLOCKED_PAUSE_MS), window),
            consumesAttempt: false,
        };
    }
    if (input.disposition && reattemptRuleFor(input.disposition)) {
        return planReattempt(input);
    }
    const at = planRetry(input);
    return at ? { at, consumesAttempt: true } : null;
}

// ── Dispositions v3: the sheet's re-attempt rule per disposition ────────────
//
// docs/tasks/AI_Dispositions_4Nov.xlsx, column "Re-attempt rule". Keyed by the
// label dispositionV3 writes (the L3, or the L2 for a not-connected reason).
//
//   after         a fixed gap (15 min, 30 min, 2 h), clamped into the window
//   next_window   the next half-day window (10-14 / 14-19 inside dialler hours)
//   next_day      tomorrow, in the SAME half-day window or the OTHER one
//   at_requested  the time the dealer asked for; none given: next day, same window
//   long          outlives the campaign: 3 / 7 / 30 / 90 days (ai_redial_plan)
//   none          the AI does not redial (a person follows up, or the number is retired)
//
// maxPerDay / maxDays / maxTimes cap the rule; max_retries stays the outer cap
// for redials inside the campaign.

export type ReattemptRule =
    | { kind: "after"; ms: number; maxPerDay?: number; maxTimes?: number; thenNextDay?: boolean }
    | { kind: "next_window"; maxPerDay?: number; maxDays?: number }
    | { kind: "next_day"; window: "same" | "other"; maxTimes?: number }
    | { kind: "at_requested" }
    | { kind: "long"; days: number; once: boolean }
    | { kind: "none" };

export const REATTEMPT_RULES: Readonly<Record<string, ReattemptRule>> = {
    // Connected › Machine
    "IVR / auto-attendant": { kind: "none" }, // number retired for the campaign
    "Recording / voicemail": { kind: "next_day", window: "same", maxTimes: 1 },
    "Tracking number, no voice": { kind: "none" }, // retired; find the shop's mobile
    "Dead audio (no sound either way)": { kind: "after", ms: 15 * MIN, maxTimes: 1, thenNextDay: true },
    // Connected › Cold
    "Loan Procedure Issue": { kind: "none" }, // a person calls back within 24 h
    "Service Issue": { kind: "none" },
    "Ask to Call Back": { kind: "at_requested" },
    "Need Some Time": { kind: "long", days: 7, once: false },
    "No requirement in current": { kind: "long", days: 30, once: false },
    "Bad Experience with Trontek": { kind: "none" }, // complaint: never redial from the AI
    "Hung up during intro": { kind: "next_day", window: "other" },
    "Wrong person (staff / family)": { kind: "next_day", window: "same" },
    "Dropped mid-call": { kind: "after", ms: 15 * MIN, maxTimes: 1 },
    "Language mismatch": { kind: "next_day", window: "same" },
    "Short Hang up": { kind: "next_day", window: "other" }, // retired label, old rows
    // Connected › Warm / Hot / Converted — a person owns the lead from here.
    "Details Shared": { kind: "none" },
    "Information Collected": { kind: "none" },
    "Meeting Scheduled": { kind: "none" },
    "Commercials Explained": { kind: "long", days: 3, once: false },
    "Price High": { kind: "long", days: 7, once: false },
    "Quotation Sent": { kind: "none" },
    "Under Negotiation": { kind: "none" },
    "Documents Received": { kind: "none" },
    "Commercials Finalised": { kind: "none" },
    "Deal Closed": { kind: "none" },
    "Order Received": { kind: "none" },
    "Full Payment Received": { kind: "none" },
    "Onboarding Done": { kind: "none" },
    // Connected › Lost
    "Not Interested": { kind: "long", days: 90, once: true },
    "Lost to Competition": { kind: "long", days: 90, once: true },
    "Some other Business": { kind: "none" }, // out of segment
    "Business Closed": { kind: "none" },
    "REJECTED BY US": { kind: "none" },
    // Not Connected
    "Did not pick": { kind: "next_window", maxPerDay: 2, maxDays: 3 },
    "Busy in another call": { kind: "after", ms: 30 * MIN, maxPerDay: 2 },
    "User disconnected the call": { kind: "next_day", window: "other" },
    "Switch off": { kind: "next_day", window: "same" },
    "Out of Coverage area / Network issue": { kind: "after", ms: 2 * HOUR },
    // Our side refused. The line-blocked refund above handles it first; past
    // the refund cap it is a plain failure, retried in the next window.
    "Call not connected / can not be completed": { kind: "next_window" },
    "Other reason": { kind: "next_day", window: "same" },
    "Incorrect / Invalid number": { kind: "none" }, // fix the lead
    "Incoming calls not available": { kind: "long", days: 7, once: false },
    "Number not in use / does not exist / out of service": { kind: "none" }, // retired
};

export function reattemptRuleFor(disposition: string | null | undefined): ReattemptRule | null {
    if (!disposition) return null;
    return REATTEMPT_RULES[disposition] ?? null;
}

/** The split of a (dialler-hours) window into [start, split) and [split, end). */
function halves(window: RetryWindow): { split: number; start: number; end: number } {
    const start = hhmmToMinutes(window.start);
    const end = hhmmToMinutes(window.end);
    const preferred = 14 * 60;
    const split = start < preferred && preferred < end ? preferred : Math.floor((start + end) / 2);
    return { split, start, end };
}

/** The first allowed day at/after `dayIndex`, within a week; null if none. */
function allowedDayFrom(dayIndex: number, window: RetryWindow): number | null {
    for (let n = 0; n <= 7; n++) {
        const weekday = WEEKDAY_BY_UTC_DAY[new Date((dayIndex + n) * DAY_MS).getUTCDay()];
        if (dayAllowed(window, weekday)) return dayIndex + n;
    }
    return null;
}

function atIst(dayIndex: number, minute: number): Date {
    return new Date(dayIndex * DAY_MS + minute * MIN - IST_OFFSET_MS);
}

/**
 * Tomorrow (or the next allowed day), in the same half-day window as `now` or
 * the other one. Keeps the same offset into the half, so a day's redials do
 * not all stack on the hour.
 */
export function nextDayInWindow(now: Date, window: RetryWindow, which: "same" | "other"): Date | null {
    const w = withinDialerHours(window);
    const { split, start, end } = halves(w);
    const { dayIndex, minute } = istParts(now);
    const inMorning = minute < split;
    const morning = which === "same" ? inMorning : !inMorning;
    const [from, to] = morning ? [start, split] : [split, end];
    const ownFrom = inMorning ? start : split;
    const offset = Math.max(0, Math.min(minute - ownFrom, to - from - 1));
    const day = allowedDayFrom(dayIndex + 1, w);
    return day == null ? null : atIst(day, from + offset);
}

/** The next half-day window opening strictly after `now`. */
export function nextHalfWindow(now: Date, window: RetryWindow): Date | null {
    const w = withinDialerHours(window);
    const { split, start } = halves(w);
    const { dayIndex, minute } = istParts(now);
    const weekday = WEEKDAY_BY_UTC_DAY[new Date(dayIndex * DAY_MS).getUTCDay()];
    if (dayAllowed(w, weekday)) {
        if (minute < start) return atIst(dayIndex, start);
        if (minute < split) return atIst(dayIndex, split);
    }
    const day = allowedDayFrom(dayIndex + 1, w);
    return day == null ? null : atIst(day, start);
}

/** IST day index of an ISO time, or null. */
function dayOf(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = new Date(iso);
    return Number.isFinite(t.getTime()) ? istParts(t).dayIndex : null;
}

/** The IST day of this row's first dial (history, or today). */
function firstDialDay(history: ReadonlyArray<ReattemptHistoryEntry>, now: Date): number {
    let first = istParts(now).dayIndex;
    for (const h of history) {
        const d = dayOf(h.at);
        if (d != null && d < first) first = d;
    }
    return first;
}

/**
 * The sheet's rule for this dial's disposition. Pure; see REATTEMPT_RULES.
 * null = the row is done (no redial, nothing long-horizon).
 */
export function planReattempt(input: RetryInput): RetryPlan | null {
    const rule = reattemptRuleFor(input.disposition);
    if (!rule || rule.kind === "none") return null;
    const window = withinDialerHours(input.window);
    const history = input.history ?? [];
    const sameDispBefore = history.filter(
        (h) => h.counted !== false && h.disp === input.disposition,
    ).length;

    if (rule.kind === "long") {
        // Outlives the campaign: the campaign's retry budget does not apply.
        if (rule.once && sameDispBefore > 0) return null;
        const at = clampIntoWindow(new Date(input.now.getTime() + rule.days * DAY_MS), window);
        return { at, consumesAttempt: true, longHorizon: { once: rule.once } };
    }

    // A redial inside the campaign: the E-315 budget is the outer cap.
    const { maxRetries, attemptCount } = input;
    if (maxRetries == null || maxRetries <= 0) return null;
    if (attemptCount < 1 || attemptCount >= 1 + maxRetries) return null;

    let at: Date | null = null;
    switch (rule.kind) {
        case "after": {
            if (rule.maxTimes != null && sameDispBefore >= rule.maxTimes) {
                // Used up. Dead audio gets one more try the next day.
                if (!rule.thenNextDay || sameDispBefore > rule.maxTimes) return null;
                at = nextDayInWindow(input.now, window, "same");
                break;
            }
            at = clampIntoWindow(new Date(input.now.getTime() + rule.ms), window);
            break;
        }
        case "next_window":
            at = nextHalfWindow(input.now, window);
            break;
        case "next_day":
            if (rule.maxTimes != null && sameDispBefore >= rule.maxTimes) return null;
            at = nextDayInWindow(input.now, window, rule.window);
            break;
        case "at_requested": {
            const asked = input.requestedAt;
            at =
                asked && asked.getTime() > input.now.getTime()
                    ? clampIntoWindow(asked, window)
                    : nextDayInWindow(input.now, window, "same");
            break;
        }
    }
    if (!at) return null;

    // B3: at most two dials a day (or the rule's own lower cap). A third waits
    // for tomorrow's window.
    const ruleCap = "maxPerDay" in rule && rule.maxPerDay != null ? rule.maxPerDay : MAX_DIALS_PER_DAY;
    const perDay = Math.min(MAX_DIALS_PER_DAY, ruleCap);
    const today = istParts(input.now).dayIndex;
    if ((input.dialsToday ?? 0) >= perDay && istParts(at).dayIndex === today) {
        const day = allowedDayFrom(today + 1, window);
        if (day == null) return null;
        at = atIst(day, hhmmToMinutes(window.start));
    }

    // "Did not pick": only for the first maxDays IST days of this row.
    if (rule.kind === "next_window" && rule.maxDays != null) {
        if (istParts(at).dayIndex - firstDialDay(history, input.now) >= rule.maxDays) return null;
    }
    return { at, consumesAttempt: true };
}

/**
 * When to redial, or null for "this lead is done".
 * `attemptCount` counts the dial that just ended, so with maxRetries=3 a lead
 * gets at most 4 dials in total.
 */
export function planRetry(input: RetryInput): Date | null {
    const { maxRetries, attemptCount } = input;
    if (maxRetries == null || maxRetries <= 0) return null;
    if (attemptCount < 1 || attemptCount >= 1 + maxRetries) return null;
    if (!isAutoRetryable(input.status, input.callOutcome)) return null;

    const window = withinDialerHours(input.window);
    const gaps = input.status === "busy" ? BUSY_GAPS : DEFAULT_GAPS;
    // attemptCount 1 → first retry → gaps[0]. Past the table, reuse its tail.
    const gap = gaps[Math.min(attemptCount - 1, gaps.length - 1)];

    const at =
        gap === "next_window"
            ? nextWindowOpen(input.now, window)
            : clampIntoWindow(new Date(input.now.getTime() + gap), window);
    if (!at) return null;

    // B3 — the day's two dials are spent: the redial waits for tomorrow's window.
    if (
        (input.dialsToday ?? 0) >= MAX_DIALS_PER_DAY &&
        istParts(at).dayIndex === istParts(input.now).dayIndex
    ) {
        const tomorrow = new Date((istParts(input.now).dayIndex + 1) * DAY_MS - IST_OFFSET_MS);
        return clampIntoWindow(tomorrow, window);
    }
    return at;
}

// ── IST calendar arithmetic ────────────────────────────────────────────────
// India has no DST, so IST is a fixed +05:30 and plain offset maths is exact.

const IST_OFFSET_MS = 330 * MIN;
const DAY_MS = 24 * HOUR;
const WEEKDAY_BY_UTC_DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function hhmmToMinutes(s: string): number {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
}

function minutesToHhmm(n: number): string {
    return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/** IST wall clock of an instant: whole-day index since epoch + minute of day. */
function istParts(t: Date): { dayIndex: number; minute: number; weekday: string } {
    const shifted = t.getTime() + IST_OFFSET_MS;
    const dayIndex = Math.floor(shifted / DAY_MS);
    const minute = Math.floor((shifted - dayIndex * DAY_MS) / MIN);
    const weekday = WEEKDAY_BY_UTC_DAY[new Date(dayIndex * DAY_MS).getUTCDay()];
    return { dayIndex, minute, weekday };
}

function dayAllowed(window: RetryWindow, weekday: string): boolean {
    return !window.days || window.days.length === 0 || window.days.includes(weekday);
}

/**
 * Same membership rule as campaignWindow.windowOpenSql, so the retry time and
 * the dial-time gate can never disagree: the weekday is the one of `t` itself
 * (also for the after-midnight half of an overnight window).
 */
export function isWindowOpen(t: Date, window: RetryWindow): boolean {
    const { minute, weekday } = istParts(t);
    if (!dayAllowed(window, weekday)) return false;
    const start = hhmmToMinutes(window.start);
    const end = hhmmToMinutes(window.end);
    if (end > start) return minute >= start && minute < end;
    return minute >= start || minute < end;
}

/**
 * The next window opening strictly after `t` — a port of nextWindowOpenSql
 * (8-day walk, strictly-after) so a Monday-only window resolves next Monday.
 */
export function nextWindowOpen(t: Date, window: RetryWindow): Date | null {
    const { dayIndex } = istParts(t);
    const start = hhmmToMinutes(window.start);
    for (let n = 0; n <= 7; n++) {
        const day = dayIndex + n;
        const weekday = WEEKDAY_BY_UTC_DAY[new Date(day * DAY_MS).getUTCDay()];
        if (!dayAllowed(window, weekday)) continue;
        const at = new Date(day * DAY_MS + start * MIN - IST_OFFSET_MS);
        if (at.getTime() > t.getTime()) return at;
    }
    return null;
}

/** `t` if the window is open then, else the next opening (or `t` if none). */
export function clampIntoWindow(t: Date, window: RetryWindow): Date {
    if (isWindowOpen(t, window)) return t;
    return nextWindowOpen(t, window) ?? t;
}
