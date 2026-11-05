// Carrier-refusal pause, probe and resume (Priya KPI tracker task 10, 4 Nov 2026).
//
// The rules, from the tracker:
//   - pause only on SIP 401 / 403 / 407 / 429 / 503 — never on 486 / 480 / 404,
//     which are the DEALER's line (busy, no answer, dead number);
//   - on pause: save the state, the code and the cursor at the first refused
//     lead; refund the refused attempts; one alert per pause;
//   - a probe call every 30 min, only inside 10:00–19:00 IST, up to 6 probes;
//     a placed probe resumes the campaign;
//   - a second pause on the same IST day waits for a manual Resume, which runs
//     the probe first;
//   - resume picks up from the cursor, in the same order.
//
// A config error (missing env var, bad API key) is not the carrier: it pauses
// sooner, is never probed, and needs a person to fix the setting and Resume.
//
// Pure: no database, no clock of its own. The I/O is in lineHealth.ts.

import { extractSipCode, CARRIER_REFUSAL_SIP_CODES } from "./dispositionV3";
import { classifyTriggerDetail } from "./failureReason";

export type LineBlockKind = "carrier" | "setup";

/** Refused in a row before a carrier pause (D1, E-360). */
export const CARRIER_PAUSE_THRESHOLD = 10;
/** Config errors in a row before a setup pause: every dial would fail the same way. */
export const SETUP_PAUSE_THRESHOLD = 3;

export const PROBE_INTERVAL_MS = 30 * 60_000;
export const MAX_PROBES = 6;
/** Probes only run inside these IST hours. */
export const PROBE_HOURS = { start: "10:00", end: "19:00" } as const;
/** The number the probe rings (tracker task 10); overridable in Settings › Dialer alerts. */
export const DEFAULT_PROBE_NUMBER = "9971027907";

export const CARRIER_PAUSE_REASON = "carrier_refused";
export const SETUP_PAUSE_REASON = "setup_error";

const TRIGGER_PREFIX = /^trigger_(?:failed|exception):\s*/i;

/**
 * Whose fault a failed dial was, when it was ours. `outcome` is the stored
 * call_outcome ("trigger_failed: …", or an initiation failure carrying
 * "(sip status: 503)"). null = it reached the dealer's network (busy, no
 * answer, dead number, a placed call) or it is not a failure at all.
 */
export function lineBlockKind(outcome: string | null | undefined): LineBlockKind | null {
    const text = (outcome ?? "").trim();
    if (!text) return null;
    const sip = extractSipCode(text);
    if (sip != null) return CARRIER_REFUSAL_SIP_CODES.has(sip) ? "carrier" : null;
    const detail = text.replace(TRIGGER_PREFIX, "").toLowerCase();
    if (detail.includes("too many requests") || detail.includes("rate limit")) return "carrier";
    // Only a dial the dialer itself failed to place can be a setup error.
    if (TRIGGER_PREFIX.test(text) && classifyTriggerDetail(detail) === "config_error") return "setup";
    return null;
}

export function pauseThreshold(kind: LineBlockKind): number {
    return kind === "carrier" ? CARRIER_PAUSE_THRESHOLD : SETUP_PAUSE_THRESHOLD;
}

// ── IST clock ───────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** The IST calendar day of `t`, as YYYY-MM-DD. */
export function istDay(t: Date): string {
    return new Date(t.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMinute(t: Date): number {
    const shifted = t.getTime() + IST_OFFSET_MS;
    return Math.floor((shifted - Math.floor(shifted / DAY_MS) * DAY_MS) / 60_000);
}

function hhmm(s: string): number {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
}

export function withinProbeHours(t: Date): boolean {
    const m = istMinute(t);
    return m >= hhmm(PROBE_HOURS.start) && m < hhmm(PROBE_HOURS.end);
}

/** `t` if inside probe hours, else the next 10:00 IST. */
export function clampToProbeHours(t: Date): Date {
    if (withinProbeHours(t)) return t;
    const shifted = t.getTime() + IST_OFFSET_MS;
    let day = Math.floor(shifted / DAY_MS);
    if (istMinute(t) >= hhmm(PROBE_HOURS.start)) day += 1; // after 19:00 → tomorrow
    return new Date(day * DAY_MS + hhmm(PROBE_HOURS.start) * 60_000 - IST_OFFSET_MS);
}

// ── Decisions ───────────────────────────────────────────────────────────────

export type PauseDecision = {
    reason: typeof CARRIER_PAUSE_REASON | typeof SETUP_PAUSE_REASON;
    /** The IST day this pause counts against. */
    pauseDay: string;
    /** Pauses on that day INCLUDING this one. */
    pausesToday: number;
    /** A person must press Resume (and the probe runs first). */
    needsManualResume: boolean;
    /** When the first automatic probe runs; null = no automatic probe. */
    nextProbeAt: Date | null;
};

/**
 * What a new pause looks like. `previous` is the stored pause day / count, so
 * the second carrier pause on the same IST day waits for a person.
 */
export function decidePause(input: {
    kind: LineBlockKind;
    now: Date;
    previous: { pauseDay: string | null; pausesToday: number | null };
}): PauseDecision {
    const today = istDay(input.now);
    const pausesToday =
        input.previous.pauseDay === today ? Math.max(0, input.previous.pausesToday ?? 0) + 1 : 1;
    if (input.kind === "setup") {
        return {
            reason: SETUP_PAUSE_REASON,
            pauseDay: today,
            pausesToday,
            needsManualResume: true,
            nextProbeAt: null,
        };
    }
    const manual = pausesToday >= 2;
    return {
        reason: CARRIER_PAUSE_REASON,
        pauseDay: today,
        pausesToday,
        needsManualResume: manual,
        nextProbeAt: manual
            ? null
            : clampToProbeHours(new Date(input.now.getTime() + PROBE_INTERVAL_MS)),
    };
}

export type ProbeOutcome =
    | { kind: "resume" }
    | { kind: "again"; nextProbeAt: Date }
    | { kind: "exhausted" };

/**
 * After an automatic probe. `probesUsed` counts this one. A refused probe
 * books the next one 30 min on (inside probe hours) until MAX_PROBES; then the
 * campaign waits for a person.
 */
export function afterProbe(input: { placed: boolean; probesUsed: number; now: Date }): ProbeOutcome {
    if (input.placed) return { kind: "resume" };
    if (input.probesUsed >= MAX_PROBES) return { kind: "exhausted" };
    return {
        kind: "again",
        nextProbeAt: clampToProbeHours(new Date(input.now.getTime() + PROBE_INTERVAL_MS)),
    };
}

/** Is an automatic probe due for this pause? */
export function probeDue(input: {
    reason: string | null;
    needsManualResume: boolean;
    nextProbeAt: Date | null;
    probesUsed: number;
    now: Date;
}): boolean {
    return (
        input.reason === CARRIER_PAUSE_REASON &&
        !input.needsManualResume &&
        input.nextProbeAt != null &&
        input.nextProbeAt.getTime() <= input.now.getTime() &&
        input.probesUsed < MAX_PROBES &&
        withinProbeHours(input.now)
    );
}
