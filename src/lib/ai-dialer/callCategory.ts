// AI dialer review (23 Oct 2026, points 1–3) — ONE outcome category per call.
//
// campaignLeadStatus.classifyCallEnd answers "did the dealer speak?" (the
// campaign row's status). This answers the next question: what came of it —
// interested, a callback (and who makes it), asked for a manager, not
// interested, cut off mid-conversation, unavailable … The category is the
// foundation the callback flow, the retry of dropped calls and the campaign
// outcome report all read, so it is decided ONCE, here, from facts the
// finalizers already have.
//
// Pure: no DB, no clock of its own (`now` is passed in) — vitest covers it.
// Writers: src/lib/ai/storage/callOutcomeStore.ts (both finalizers).
// Stored: ai_call_outcomes.category (E-356).

import type { CallEndStatus } from "./campaignLeadStatus";
import { clampIntoWindow, type RetryWindow } from "./retryPolicy";
import { extractDealerLines, parseCallbackTimeFromTranscript } from "@/lib/ai/analysis/postCallHelpers";
import type { CallbackTopic, QualificationSignals } from "@/lib/ai/scoring/signals";
import type { Band, CallStatus } from "@/lib/ai/scoring/computeBand";

/** Bump when the rule below changes — stamped on every ai_call_outcomes row. */
// category-1.3.0 (3 Nov 2026) — every unreached call gets a specific reason:
// Wrong Number, No Response, Out of Service, Busy, Unavailable, Call
// Disconnected, Early Hang-up. "Unavailable" used to hold all of them.
export const CALL_CATEGORY_VERSION = "category-1.3.0";

export const CALL_CATEGORIES = [
    // ── connected: the dealer spoke ──
    "interested",
    "callback_ai",
    "callback_sales",
    "sales_manager_request",
    "not_interested",
    "not_relevant",
    "disconnected",
    "no_interest_signal",
    "needs_review",
    // ── not connected ──
    "wrong_number",
    "no_response",
    "out_of_service",
    "busy",
    "unavailable",
    "hung_up",
    "failed",
] as const;
export type CallCategory = (typeof CALL_CATEGORIES)[number];

export const CALL_CATEGORY_LABELS: Record<CallCategory, string> = {
    interested: "Interested",
    callback_ai: "Callback — AI",
    callback_sales: "Callback — Sales",
    sales_manager_request: "Asked for Sales Manager",
    not_interested: "Not interested",
    not_relevant: "Not our market",
    disconnected: "Call Disconnected",
    no_interest_signal: "No interest shown",
    needs_review: "Needs review",
    wrong_number: "Wrong Number",
    no_response: "No Response",
    out_of_service: "Out of Service",
    busy: "Busy",
    unavailable: "Unavailable",
    hung_up: "Early Hang-up",
    failed: "Call failed (system)",
};

/** Display order for the report — the actionable ones first. */
export const CALL_CATEGORY_ORDER: readonly CallCategory[] = [
    "interested",
    "sales_manager_request",
    "callback_sales",
    "callback_ai",
    "disconnected",
    "no_interest_signal",
    "not_interested",
    "not_relevant",
    "needs_review",
    "hung_up",
    "no_response",
    "busy",
    "out_of_service",
    "unavailable",
    "wrong_number",
    "failed",
];

export function isCallCategory(v: unknown): v is CallCategory {
    return typeof v === "string" && (CALL_CATEGORIES as readonly string[]).includes(v);
}

export type CallbackOwner = "ai" | "sales";

const HARD_DISQUALIFIERS = new Set(["dont_call", "hostile", "not_interested"]);

/** The slice of a successful analysis this rule reads. */
export type CategoryAnalysis = {
    band: Band | null;
    call_status: CallStatus;
    info_signals_count: number;
    signals: Pick<
        QualificationSignals,
        | "lithium_dealer"
        | "relevant_dealer"
        | "callback_agreed"
        | "callback_topic"
        | "wants_human"
        | "disqualifier"
    >;
};

export type CategoryInput = {
    /** classifyCallEnd().status — where the campaign row lands. */
    campaignStatus: CallEndStatus;
    /** classifyCallEnd().outcome ?? the provider status. */
    callOutcome?: string | null;
    /** null when there was no transcript, or analysis did not run. */
    analysis: CategoryAnalysis | null;
    /**
     * The voice agent's own call_result (ElevenLabs data collection), when it
     * sends one: wrong_number / owner_not_available decide a connected call.
     */
    agentCallResult?: string | null;
    /** The transcript was sent to the model and the model failed. */
    analysisFailed?: boolean;
};

export type CategoryResult = {
    category: CallCategory;
    /** The dealer spoke (campaign status 'completed'). */
    connected: boolean;
    /** Who makes the callback, when the call produced one. */
    callbackOwner: CallbackOwner | null;
    callbackTopic: CallbackTopic | null;
    wantsHuman: boolean;
    /**
     * Review point 8 — the conversation was cut off before it finished, so the
     * campaign should redial (retryPolicy treats call_outcome 'disconnected'
     * as retryable even though the row is 'completed').
     */
    retryAsDisconnected: boolean;
};

// 3 Nov 2026 — the specific reason for every unreached call.
//   no_response  rang out, or answered and the dealer never said a word
//   busy         engaged, or declined (a declined call plays "busy" in India)
//   unavailable  a machine took it: voicemail, auto-reply, IVR / switchboard
//   hung_up      Early Hang-up — dropped before / during the introduction
// out_of_service and wrong_number come from the outcome (carrier message or
// SIP code), see notConnectedCategory.
const NOT_CONNECTED: Partial<Record<CallEndStatus, CallCategory>> = {
    no_response: "no_response",
    silent: "no_response",
    no_conversation: "no_response",
    busy: "busy",
    rejected: "busy",
    voicemail: "unavailable",
    switchboard: "unavailable",
    hung_up: "hung_up",
};

const WRONG_NUMBER_OUTCOME = /invalid_number|wrong_number|sip status: ?(404|484|604)|SIP (404|484|604)/i;
const OUT_OF_SERVICE_OUTCOME = /out_of_service|switched_off|unreachable|out_of_coverage/i;
const DISCONNECTED_OUTCOME_RE = /disconnect|cancell?ed/i;

/** The category of a call the dealer did not speak on. */
export function notConnectedCategory(status: CallEndStatus, callOutcome?: string | null): CallCategory {
    const outcome = callOutcome ?? "";
    if (WRONG_NUMBER_OUTCOME.test(outcome)) return "wrong_number";
    if (status === "failed") {
        // The line dropped on the network after it was placed — not our setup.
        return DISCONNECTED_OUTCOME_RE.test(outcome) ? "disconnected" : "failed";
    }
    if (OUT_OF_SERVICE_OUTCOME.test(outcome)) return "out_of_service";
    return NOT_CONNECTED[status] ?? "no_response";
}

export function categorizeCall(input: CategoryInput): CategoryResult {
    const none = { callbackOwner: null, callbackTopic: null, wantsHuman: false, retryAsDisconnected: false };

    if (input.campaignStatus !== "completed") {
        return { category: notConnectedCategory(input.campaignStatus, input.callOutcome), connected: false, ...none };
    }

    // A person answered and said it is the wrong number.
    const agentResult = (input.agentCallResult ?? "").trim().toLowerCase();
    if (agentResult === "wrong_number") {
        return { category: "wrong_number", connected: true, ...none };
    }

    // ── The dealer spoke. ──
    const a = input.analysis;
    if (!a) {
        return { category: input.analysisFailed ? "needs_review" : "no_interest_signal", connected: true, ...none };
    }

    const s = a.signals;
    const callbackYes = s.callback_agreed === "yes";
    const wantsHuman = s.wants_human === "yes";
    const topic: CallbackTopic = s.callback_topic ?? "none";

    // D8 — a complaint is a person's job whatever else was said: the loop
    // assigns it, labelled Complaint, and nobody pitches.
    if (topic === "complaint") {
        return {
            category: "callback_sales",
            connected: true,
            callbackOwner: "sales",
            callbackTopic: "complaint",
            wantsHuman: false,
            retryAsDisconnected: false,
        };
    }

    // A firm no beats anything said before it.
    if (HARD_DISQUALIFIERS.has(s.disqualifier)) {
        return { category: "not_interested", connected: true, ...none };
    }
    // Not our market (outside our product lines → Disqualified; D10) — unless he
    // still asked for a person, which a rep should hear. A lead-acid dealer IN
    // our lines is Warm and keeps his callback.
    if (a.band === "Disqualified" && !wantsHuman) {
        return { category: "not_relevant", connected: true, ...none };
    }

    if (wantsHuman) {
        return {
            category: "sales_manager_request",
            connected: true,
            callbackOwner: "sales",
            callbackTopic: topic,
            wantsHuman: true,
            retryAsDisconnected: false,
        };
    }

    if (callbackYes) {
        // Every agreed callback goes to Sales (26 Oct 2026): Priya's script
        // promises "our sales manager will call", whatever the topic. The topic
        // stays on the record so the rep knows what the dealer wants.
        // (callback_ai is kept for rows written by category-1.0.0.)
        return {
            category: "callback_sales",
            connected: true,
            callbackOwner: "sales",
            callbackTopic: topic,
            wantsHuman: false,
            retryAsDisconnected: false,
        };
    }

    // Cut off before the conversation finished. A Qualified lead is not
    // redialled — it already went to the sales team with what was captured.
    if (s.disqualifier === "call_dropped" && a.band !== "Qualified") {
        return { category: "disconnected", connected: true, ...none, retryAsDisconnected: true };
    }

    if (a.band === "Qualified" || a.info_signals_count >= 1) {
        return { category: "interested", connected: true, ...none };
    }
    // Someone else picked up and the owner was not there — no callback agreed.
    if (agentResult === "owner_not_available") {
        return { category: "unavailable", connected: true, ...none };
    }
    return { category: "no_interest_signal", connected: true, ...none };
}

// ── When is the callback due? ───────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const IST_OFFSET_MS = 330 * MIN;
/** A model-read time further out than this is not trusted. */
const MAX_AHEAD_MS = 30 * 24 * HOUR;
/** No time named: the AI calls back a day later (a person: next working morning, D8). */
const AI_DEFAULT_DELAY_MS = 24 * HOUR;

/** IST wall-clock `hour:00`, `dayShift` days after `now`'s IST date. */
function istAt(now: Date, dayShift: number, hour: number): Date {
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    return new Date(
        Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + dayShift, hour, 0) -
            IST_OFFSET_MS,
    );
}

/**
 * D8 — the promised time from words with no clock: evening = 17:00, afternoon
 * = 14:00, morning = 11:00, "kal / tomorrow" alone = 11:00 the next day. A
 * time already past today means the next day. null when no such word is there.
 */
export function partOfDayTime(text: string, now: Date): Date | null {
    const t = text.toLowerCase();
    const hour = /shaam|sham\b|शाम|evening/.test(t)
        ? 17
        : /dopahar|dophar|दोपहर|afternoon/.test(t)
          ? 14
          : /subah|सुबह|morning/.test(t)
            ? 11
            : /kal|कल|tomorrow|parso|परसों|day after/.test(t)
              ? 11
              : null;
    if (hour == null) return null;
    const dayShift = /parso|परसों|day after/.test(t) ? 2 : /kal|कल|tomorrow/.test(t) ? 1 : 0;
    const at = istAt(now, dayShift, hour);
    return at.getTime() <= now.getTime() ? new Date(at.getTime() + 24 * HOUR) : at;
}

/**
 * D8 — 11:00 on the next working day (the window's days), for a callback with
 * no time agreed and for a lead Qualified with no callback.
 */
export function nextWorkingMorning(now: Date, window: RetryWindow): Date {
    return clampIntoWindow(istAt(now, 1, 11), window);
}

/** "5 baje", "शाम 6 बजे", "4 pm", "kal 11 baje" → an IST clock time after `now`. */
export function parseClockTime(text: string, now: Date): Date | null {
    const t = text.toLowerCase();
    const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(baje|बजे|pm|am|o'?clock)/i);
    if (!m) return null;
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return null;
    const unit = m[3].toLowerCase();
    const evening = /shaam|sham|शाम|evening|raat|रात|night/.test(t) || unit === "pm";
    const morning = /subah|सुबह|morning/.test(t) || unit === "am";
    if (evening && hour < 12) hour += 12;
    // A bare "5 baje" in a working day means 5 pm, not 5 am.
    else if (!morning && hour >= 1 && hour <= 7) hour += 12;

    const dayShift = /parso|परसों|day after/.test(t) ? 2 : /kal|कल|tomorrow/.test(t) ? 1 : 0;
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    const at = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + dayShift, hour, minute) - IST_OFFSET_MS;
    // "5 baje" said at 6 pm today means tomorrow.
    return new Date(at <= now.getTime() ? at + 24 * HOUR : at);
}

/**
 * The callback's due time, in the calling window:
 *   1. the model's callback_at, when it is a real time within the next 30 days;
 *   2. the dealer's own words (callback_when, then his transcript lines) — a
 *      clock time ("5 baje") or a delay ("2 ghante", "kal");
 *   3. otherwise a default delay by owner.
 * Always moved INTO the window, so nobody is called back at night.
 */
export function callbackDueAt(input: {
    owner: CallbackOwner;
    callbackAt?: string | null;
    callbackWhen?: string | null;
    transcript?: string | null;
    now: Date;
    window: RetryWindow;
}): Date {
    const { now } = input;
    const nowMs = now.getTime();
    let due: Date | null = null;

    if (input.callbackAt) {
        const d = new Date(input.callbackAt);
        const ms = d.getTime();
        if (!isNaN(ms) && ms > nowMs - 10 * MIN && ms < nowMs + MAX_AHEAD_MS) due = new Date(Math.max(ms, nowMs));
    }
    if (!due && input.callbackWhen) {
        due =
            parseClockTime(input.callbackWhen, now) ??
            partOfDayTime(input.callbackWhen, now) ??
            relativeFrom(`user: ${input.callbackWhen}`, now);
    }
    if (!due && input.transcript) {
        const lines = extractDealerLines(input.transcript);
        due = parseClockTime(lines, now) ?? relativeFrom(input.transcript, now) ?? partOfDayTime(lines, now);
    }
    if (!due) {
        return input.owner === "sales"
            ? nextWorkingMorning(now, input.window)
            : clampIntoWindow(new Date(nowMs + AI_DEFAULT_DELAY_MS), input.window);
    }
    return clampIntoWindow(due, input.window);
}

/**
 * A delay that fixes the time of day: "2 ghante", "30 minute", "thodi der".
 * A day count ("2 din baad") or a bare "kal" names a day, not a time.
 */
const HOUR_DELAY =
    /\d+\s*(?:minute|min|मिनट|मिनिट|hour|hr|घंटा|घंटे|ghanta|ghante)|thodi der|thoda time|थोड़ी देर|थोड़ा टाइम/i;

/** A part-of-day word (morning / afternoon / evening), in Hindi or English. */
export function hasPartOfDay(text: string | null | undefined): boolean {
    return /shaam|sham\b|शाम|evening|dopahar|dophar|दोपहर|afternoon|subah|सुबह|morning|raat|रात|night/i.test(text ?? "");
}

/**
 * Task 11 (D8, 4 Nov 2026) — callbackDueAt plus whether the DEALER set the
 * time. "Never a silent 11:00": when he named no clock time, no part of the
 * day and no delay ("2 ghante") — nothing, or a bare "kal" — the callback is
 * flagged time-not-set and falls due at the next working day's window
 * opening, so the ISR knows to ask rather than trusting an invented hour.
 *
 * The model's callback_at counts as set only when the dealer's own words carry
 * a time: the analyser turns a bare "kal" into "tomorrow 11:00" as readily as
 * the old default did.
 */
export function callbackDueDetail(input: {
    owner: CallbackOwner;
    callbackAt?: string | null;
    callbackWhen?: string | null;
    transcript?: string | null;
    now: Date;
    window: RetryWindow;
}): { at: Date; timeSet: boolean } {
    const { now } = input;
    const words = [input.callbackWhen ?? "", input.transcript ? extractDealerLines(input.transcript) : ""].join(" ");
    const said = parseClockTime(words, now) != null || hasPartOfDay(words) || HOUR_DELAY.test(words);
    if (said) return { at: callbackDueAt(input), timeSet: true };
    if (input.owner !== "sales") return { at: callbackDueAt(input), timeSet: false };
    return { at: firstOpeningNextWorkingDay(now, input.window), timeSet: false };
}

/** The window's opening on the next working day (the window's days). */
export function firstOpeningNextWorkingDay(now: Date, window: RetryWindow): Date {
    return clampIntoWindow(istAt(now, 1, 0), window);
}

/** parseCallbackTimeFromTranscript, re-based on `now` (it reads the real clock). */
function relativeFrom(transcript: string, now: Date): Date | null {
    const parsed = parseCallbackTimeFromTranscript(transcript);
    if (!parsed) return null;
    return new Date(now.getTime() + (parsed.getTime() - Date.now()));
}
