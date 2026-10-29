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
export const CALL_CATEGORY_VERSION = "category-1.2.0";

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
    "unavailable",
    "hung_up",
    "wrong_number",
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
    disconnected: "Disconnected mid-call",
    no_interest_signal: "No interest shown",
    needs_review: "Needs review",
    unavailable: "Unavailable",
    hung_up: "Hung up early",
    wrong_number: "Wrong / invalid number",
    failed: "Call failed",
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
    "unavailable",
    "hung_up",
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

const NOT_CONNECTED: Partial<Record<CallEndStatus, CallCategory>> = {
    no_response: "unavailable",
    busy: "unavailable",
    rejected: "unavailable",
    voicemail: "unavailable",
    switchboard: "unavailable",
    silent: "unavailable",
    no_conversation: "unavailable",
    hung_up: "hung_up",
};

export function categorizeCall(input: CategoryInput): CategoryResult {
    const none = { callbackOwner: null, callbackTopic: null, wantsHuman: false, retryAsDisconnected: false };

    if (input.campaignStatus !== "completed") {
        if (input.campaignStatus === "failed") {
            const wrong = /invalid_number/i.test(input.callOutcome ?? "");
            return { category: wrong ? "wrong_number" : "failed", connected: false, ...none };
        }
        return { category: NOT_CONNECTED[input.campaignStatus] ?? "unavailable", connected: false, ...none };
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
    return { category: "no_interest_signal", connected: true, ...none };
}

// ── When is the callback due? ───────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const IST_OFFSET_MS = 330 * MIN;
/** A model-read time further out than this is not trusted. */
const MAX_AHEAD_MS = 30 * 24 * HOUR;
/** No time named: the AI calls back a day later; a person within 2 hours. */
const DEFAULT_DELAY_MS: Record<CallbackOwner, number> = { ai: 24 * HOUR, sales: 2 * HOUR };

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
        due = parseClockTime(input.callbackWhen, now) ?? relativeFrom(`user: ${input.callbackWhen}`, now);
    }
    if (!due && input.transcript) {
        const lines = extractDealerLines(input.transcript);
        due = parseClockTime(lines, now) ?? relativeFrom(input.transcript, now);
    }
    if (!due) due = new Date(nowMs + DEFAULT_DELAY_MS[input.owner]);
    return clampIntoWindow(due, input.window);
}

/** parseCallbackTimeFromTranscript, re-based on `now` (it reads the real clock). */
function relativeFrom(transcript: string, now: Date): Date | null {
    const parsed = parseCallbackTimeFromTranscript(transcript);
    if (!parsed) return null;
    return new Date(now.getTime() + (parsed.getTime() - Date.now()));
}
