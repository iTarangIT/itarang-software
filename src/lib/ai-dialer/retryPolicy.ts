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
};

export type RetryPlan = {
    at: Date;
    /** false = this dial never reached the dealer's network; it is refunded. */
    consumesAttempt: boolean;
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

export function isAutoRetryable(status: string, callOutcome: string | null): boolean {
    const outcome = callOutcome ?? "";
    if (NEVER_RETRY_OUTCOME.some((re) => re.test(outcome))) return false;
    if (RETRY_STATUSES.has(status)) return true;
    if (status === "failed") {
        // The watchdog's "we never heard back" — the call may never have rung.
        if (outcome === "no_webhook") return true;
        return isRetryableFailure({ status, callOutcome });
    }
    return false; // completed, skipped, pending, calling, unknown
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

/**
 * planRetry plus whether the dial that just ended counts against the lead's
 * attempt budget. null = the lead is done.
 */
export function planRetryDetailed(input: RetryInput): RetryPlan | null {
    const { maxRetries } = input;
    if (maxRetries == null || maxRetries <= 0) return null;
    if (
        isLineBlockedFailure(input.callOutcome) &&
        (input.lineBlockedRetriesUsed ?? 0) < MAX_LINE_BLOCKED_RETRIES
    ) {
        return {
            at: clampIntoWindow(new Date(input.now.getTime() + LINE_BLOCKED_PAUSE_MS), input.window),
            consumesAttempt: false,
        };
    }
    const at = planRetry(input);
    return at ? { at, consumesAttempt: true } : null;
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

    const gaps = input.status === "busy" ? BUSY_GAPS : DEFAULT_GAPS;
    // attemptCount 1 → first retry → gaps[0]. Past the table, reuse its tail.
    const gap = gaps[Math.min(attemptCount - 1, gaps.length - 1)];

    if (gap === "next_window") {
        return nextWindowOpen(input.now, input.window) ?? null;
    }
    return clampIntoWindow(new Date(input.now.getTime() + gap), input.window);
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
