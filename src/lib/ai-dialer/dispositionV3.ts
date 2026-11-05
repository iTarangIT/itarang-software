// Dispositions v3 (4 Nov 2026) — every AI dial gets an L1 / L2 / L3.
//
// Source: docs/tasks/AI_Dispositions_4Nov.xlsx, sheet "Priya auto-mapping".
// The rules are applied IN ORDER and the first match wins. Each rule keeps the
// sheet's own number, so a stored row (ai_dial_dispositions.rule_no) can be
// traced back to the line of the sheet that produced it. Rules this module adds
// for cases the sheet's table does not name carry a letter suffix ("2b", "13b",
// "14b") and sit next to the sheet rule they extend.
//
// Inputs are what the dialer already knows when a dial ends:
//   - classifyCallEnd() (campaignLeadStatus.ts) — the campaign row's verdict,
//     which is also the fallback for agents that send no data collection;
//   - the SIP code from the trigger error / initiation failure;
//   - the ElevenLabs data-collection fields answered_by, call_result,
//     callback_agreed and call_language (the testing agent defines all four);
//   - who ended the call (endedBy below) and the transcript.
//
// Pure: no database, no clock. Every edge case is in
// src/lib/ai-dialer/__tests__/dispositionV3.test.ts.

import { AGENT_LANGUAGES } from "./callLanguage";
import { parseTranscriptTurns } from "./call-quality/transcript";
import { isGreetingOnly, REMOTE_HANGUP_TERMINATION } from "./campaignLeadStatus";
import type { DispositionBucket, ConnectStatus } from "@/lib/leads/dispositions";

export const DISPOSITION_V3_VERSION = "dispositions-3.0.0";

// ── SIP codes ────────────────────────────────────────────────────────────────

/**
 * The SIP response code in a failure text, or null.
 *
 * Seen in the wild: "INVITE failed: sip status: 486: Busy Here",
 * "sip status:480", "SIP 503 Service Unavailable", "SipResponseCode=404",
 * "sip_status_code: 603". A bare number is accepted when it is a SIP-range
 * integer (the initiation-failure metadata sends it on its own).
 */
export function extractSipCode(
    ...sources: ReadonlyArray<string | number | null | undefined>
): number | null {
    for (const src of sources) {
        if (src == null) continue;
        if (typeof src === "number") {
            if (Number.isInteger(src) && src >= 100 && src <= 699) return src;
            continue;
        }
        const text = src.trim();
        if (!text) continue;
        if (/^\d{3}$/.test(text)) {
            const n = Number(text);
            if (n >= 100 && n <= 699) return n;
            continue;
        }
        const m =
            /sip[ _-]?(?:status|response)?[ _-]?(?:code)?\s*[:=]?\s*([1-6]\d{2})(?!\d)/i.exec(text);
        if (m) return Number(m[1]);
    }
    return null;
}

// ── Who ended the call ───────────────────────────────────────────────────────

export type EndedBy = "dealer" | "priya" | "line";

const PRIYA_ENDED =
    /end_call|end call|agent (?:ended|hung up|decided)|silence|inactiv|max(?:imum)?[ _-]?(?:call[ _-]?)?duration|voice ?mail detected|transfer/i;
const LINE_ENDED =
    /error|fail|sip|network|transport|websocket|timed? ?out|connection (?:lost|closed|dropped)|dropped/i;

/**
 * Who ended a connected call, from ElevenLabs' free-text termination_reason.
 *
 * PROVISIONAL until the Vobiz hang-up calibration (tracker task 7): the raw
 * reason is stored next to this verdict (ai_dial_dispositions.end_reason_raw),
 * so a corrected reading only needs the backfill re-run. null = the text says
 * nothing we recognise; rules that need "not Priya" treat null as unknown, not
 * as "the dealer".
 */
export function endedBy(terminationReason: string | null | undefined): EndedBy | null {
    const t = (terminationReason ?? "").trim();
    if (!t) return null;
    if (REMOTE_HANGUP_TERMINATION.test(t)) return "dealer";
    if (PRIYA_ENDED.test(t)) return "priya";
    if (LINE_ENDED.test(t)) return "line";
    return null;
}

// ── Transcript readings ──────────────────────────────────────────────────────

/**
 * Dealer turns AFTER Priya's opening line that are more than a greeting: the
 * sheet's "conversation started (>= 1 dealer turn after the opener)". "Hello?"
 * and "haan, kaun?" do not start a conversation.
 */
export function dealerTurnsAfterOpener(transcript: string | null | undefined): number {
    const turns = parseTranscriptTurns(transcript);
    const opener = turns.findIndex((t) => t.speaker === "agent");
    if (opener < 0) return 0;
    let n = 0;
    for (const t of turns.slice(opener + 1)) {
        if (t.speaker !== "user") continue;
        const text = t.text.trim();
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        if (isGreetingOnly(text)) continue;
        n++;
    }
    return n;
}

const INDIC_SCRIPT = /[ऀ-෿]/;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/**
 * Did Priya switch to English on a dealer speaking an Indian language? (Tracker
 * task 4: "v27 flipped Hindi dealers to English on 'Hello.'.")
 *
 * Priya's Hindi is Devanagari with English product words mixed in, so an agent
 * turn with NO Indic script and at least four Latin words, after the dealer
 * has spoken, is an English turn. Only counts when the dealer's language
 * (call_language) is not English.
 */
export function languageFlipped(
    transcript: string | null | undefined,
    callLanguage: string | null | undefined,
): boolean {
    const lang = (callLanguage ?? "").trim().toLowerCase();
    if (!lang || lang === "en" || lang === "unknown") return false;
    const turns = parseTranscriptTurns(transcript);
    let dealerHasSpoken = false;
    for (const t of turns) {
        if (t.speaker === "user" && /[\p{L}]/u.test(t.text)) {
            dealerHasSpoken = true;
            continue;
        }
        if (!dealerHasSpoken || t.speaker !== "agent") continue;
        if (INDIC_SCRIPT.test(t.text)) continue;
        if ((t.text.match(LATIN_WORD) ?? []).length >= 4) return true;
    }
    return false;
}

// ── The mapping ──────────────────────────────────────────────────────────────

export type DispositionV3Input = {
    /** classifyCallEnd().status for this dial. */
    callEndStatus: string;
    /** classifyCallEnd().outcome — early_hangup, invalid_number, out_of_service. */
    callEndOutcome?: string | null;
    /** Trigger error / initiation-failure reason / stored call_outcome. */
    failureText?: string | null;
    /** SIP code when known; otherwise read from failureText. */
    sipCode?: number | null;
    /** ElevenLabs data collection. */
    answeredBy?: string | null;
    callResult?: string | null;
    /** data collection callback_agreed, else the transcript analysis' signal. */
    callbackAgreed?: boolean | null;
    /** Transcript analysis: the dealer asked to be called later (callback_when, no agreed time). */
    askedToCallLater?: boolean | null;
    callLanguage?: string | null;
    /** languageFlipped() on the transcript. */
    languageFlip?: boolean | null;
    durationSecs?: number | null;
    endedBy?: EndedBy | null;
    /** dealerTurnsAfterOpener() on the transcript. */
    dealerTurnsAfterOpener?: number | null;
    /** campaignLeadStatus.dealerSpoke() on the transcript. */
    dealerSpoke?: boolean | null;
};

/** Facts the sheet's "Also set on the lead" column asks for. */
export type DispositionV3Effects = {
    /** Retire the number: for this campaign (IVR) or everywhere (tracking, 404/410). */
    retireNumber?: "campaign" | "number";
    /** A Google tracking number: find the shop's own mobile. */
    findShopMobile?: boolean;
    /** Count against the number's reject streak (a run of 2 → caller-ID check). */
    rejectCounter?: boolean;
    deadAudioCounter?: boolean;
    introHangupCounter?: boolean;
    /** SIP 401/403/407/429/503 — the carrier refused; the campaign counter +1. */
    carrierRefusal?: boolean;
    /** The lead's phone is wrong: flag it for a number fix. */
    numberFix?: boolean;
    /** "Need Some Time" by elimination — a person should read the transcript. */
    manualReview?: boolean;
    /** Store the dealer's language on the lead, for the redial. */
    storeLanguage?: boolean;
    /** On the redial, ask for the owner's mobile first. */
    askOwnerMobile?: boolean;
    /** The redial opens with the shorter opener. */
    shortOpener?: boolean;
};

export type DispositionV3 = {
    l1: "Connected" | "Not Connected";
    /** The sheet's L2: a bucket when connected, the reason when not. */
    l2: string;
    /** The sheet's L3 — null for a not-connected reason (they have no L3). */
    l3: string | null;
    /** The label written to touchpoints / dealer_leads.last_disposition. */
    disposition: string;
    connectStatus: ConnectStatus;
    bucket: DispositionBucket | null;
    /** Sheet rule that matched ("1".."20", or an added "2b" / "13b" / "14b"). */
    rule: string;
    sipCode: number | null;
    effects: DispositionV3Effects;
};

/** classifyCallEnd statuses where the line never answered. */
const NOT_CONNECTED_STATUSES = new Set(["busy", "no_response", "rejected", "failed", "skipped"]);

/** call_result values that mean the call reached an end on purpose. */
const CLOSING_RESULTS = new Set([
    "callback_booked",
    "busy_call_later",
    "owner_not_available",
    "not_interested",
    "not_a_fit",
    "wrong_number",
    "complaint",
    "voicemail_message_left",
    "switchboard_or_recording",
]);

/** The sheet's tracking-number / dead-audio split (rules 10 and 11). */
export const NO_VOICE_TRACKING_SECS = 14;
/** The sheet's "Hung up during intro" ceiling (rule 19). */
export const INTRO_HANGUP_SECS = 15;

/** SIP codes the sheet files under "Call not connected": the carrier refused. */
export const CARRIER_REFUSAL_SIP_CODES: ReadonlySet<number> = new Set([401, 403, 407, 429, 503]);
const BUSY_SIP = new Set([486, 600]);
const NO_ANSWER_SIP = new Set([480, 487]);
const DEAD_NUMBER_SIP = new Set([404, 410, 484, 604]);
const DECLINED_SIP = new Set([603]);

function norm(v: string | null | undefined): string {
    return (v ?? "").trim().toLowerCase();
}

function notConnected(
    l2: string,
    rule: string,
    sipCode: number | null,
    effects: DispositionV3Effects = {},
): DispositionV3 {
    return {
        l1: "Not Connected",
        l2,
        l3: null,
        disposition: l2,
        connectStatus: "not_connected",
        bucket: null,
        rule,
        sipCode,
        effects,
    };
}

function connected(
    bucket: DispositionBucket,
    l3: string,
    rule: string,
    sipCode: number | null,
    effects: DispositionV3Effects = {},
): DispositionV3 {
    return {
        l1: "Connected",
        l2: bucket,
        l3,
        disposition: l3,
        connectStatus: "connected",
        bucket,
        rule,
        sipCode,
        effects,
    };
}

/** The 20 rules of the sheet, in order. First match wins. */
export function mapDispositionV3(input: DispositionV3Input): DispositionV3 {
    const status = norm(input.callEndStatus);
    const outcome = norm(input.callEndOutcome);
    const answeredBy = norm(input.answeredBy);
    const callResult = norm(input.callResult);
    const failure = input.failureText ?? "";
    const sip = input.sipCode ?? extractSipCode(failure);
    const dur =
        input.durationSecs != null && Number.isFinite(input.durationSecs) ? input.durationSecs : null;

    // ── Rules 1–6: the dial failed (status = failed on the dialer record) ──
    if (NOT_CONNECTED_STATUSES.has(status)) {
        if ((sip != null && BUSY_SIP.has(sip)) || (sip == null && status === "busy")) {
            return notConnected("Busy in another call", "1", sip);
        }
        if (sip != null && DEAD_NUMBER_SIP.has(sip)) {
            return notConnected("Number not in use / does not exist / out of service", "3", sip, {
                retireNumber: "number",
            });
        }
        if (sip != null && CARRIER_REFUSAL_SIP_CODES.has(sip)) {
            return notConnected("Call not connected / can not be completed", "4", sip, {
                carrierRefusal: true,
            });
        }
        if (
            (sip != null && DECLINED_SIP.has(sip)) ||
            (sip == null && status === "rejected") ||
            /cancel+ed|declin|rejected/i.test(failure)
        ) {
            return notConnected("User disconnected the call", "5", sip, { rejectCounter: true });
        }
        // A carrier recording said "switched off / not reachable" (2b — the
        // sheet's L2 exists, its auto-mapping has no row for it).
        if (outcome === "out_of_service") {
            return notConnected("Switch off", "2b", sip);
        }
        if (outcome === "invalid_number") {
            return notConnected("Number not in use / does not exist / out of service", "3", sip, {
                retireNumber: "number",
            });
        }
        if (
            (sip != null && NO_ANSWER_SIP.has(sip)) ||
            (sip == null && status === "no_response") ||
            /no[ _-]?answer|ring(?:ing)?[ _-]?time ?out|not answered/i.test(failure)
        ) {
            return notConnected("Did not pick", "2", sip);
        }
        return notConnected("Other reason", "6", sip);
    }

    // ── Rule 7: a person said it is the wrong number ──
    if (callResult === "wrong_number") {
        return notConnected("Incorrect / Invalid number", "7", sip, { numberFix: true });
    }

    // ── Rules 8–11: a machine, or nothing, answered ──
    if (
        callResult === "switchboard_or_recording" ||
        answeredBy === "switchboard_or_recording" ||
        status === "switchboard"
    ) {
        return connected("Machine", "IVR / auto-attendant", "8", sip, { retireNumber: "campaign" });
    }
    if (
        answeredBy === "personal_voicemail" ||
        callResult === "voicemail_message_left" ||
        status === "voicemail"
    ) {
        return connected("Machine", "Recording / voicemail", "9", sip);
    }

    // nobody_spoke: from the agent, or — for an agent that sends no data
    // collection — a line the dealer never spoke on (silent / hung up without
    // a word). An Early Hang-up (the dealer said "hello?") is a person.
    const nobodySpoke =
        answeredBy === "nobody_spoke" ||
        (!answeredBy &&
            input.dealerSpoke !== true &&
            outcome !== "early_hangup" &&
            ["silent", "hung_up", "no_conversation"].includes(status));
    if (nobodySpoke) {
        const priyaOrUnknown = input.endedBy == null || input.endedBy === "priya";
        if (dur != null && dur >= NO_VOICE_TRACKING_SECS && priyaOrUnknown) {
            return connected("Machine", "Tracking number, no voice", "10", sip, {
                retireNumber: "number",
                findShopMobile: true,
            });
        }
        return connected("Machine", "Dead audio (no sound either way)", "11", sip, {
            deadAudioCounter: true,
        });
    }

    // ── Rules 12–20: a person answered ──
    if (input.callbackAgreed === true || callResult === "callback_booked") {
        return connected("Warm", "Information Collected", "12", sip, { storeLanguage: true });
    }
    if (callResult === "not_a_fit") {
        return connected("Lost", "REJECTED BY US", "13", sip);
    }
    if (answeredBy === "other_business") {
        return connected("Lost", "Some other Business", "13b", sip);
    }
    if (callResult === "not_interested") {
        return connected("Lost", "Not Interested", "14", sip);
    }
    if (callResult === "complaint") {
        return connected("Cold", "Bad Experience with Trontek", "14b", sip);
    }
    if (input.askedToCallLater === true || callResult === "busy_call_later") {
        return connected("Cold", "Ask to Call Back", "15", sip);
    }
    const lang = norm(input.callLanguage);
    const unheldLanguage =
        !!lang && lang !== "unknown" && !(AGENT_LANGUAGES as readonly string[]).includes(lang);
    if (input.languageFlip === true || unheldLanguage) {
        return connected("Cold", "Language mismatch", "16", sip, { storeLanguage: true });
    }
    if (
        (input.dealerTurnsAfterOpener ?? 0) >= 1 &&
        !CLOSING_RESULTS.has(callResult) &&
        (input.endedBy === "dealer" || input.endedBy === "line")
    ) {
        return connected("Cold", "Dropped mid-call", "17", sip);
    }
    if (answeredBy === "staff_or_family" || callResult === "owner_not_available") {
        return connected("Cold", "Wrong person (staff / family)", "18", sip, { askOwnerMobile: true });
    }
    const introHangup =
        (callResult === "no_conversation" || outcome === "early_hangup" || status === "hung_up") &&
        (dur == null ? outcome === "early_hangup" : dur < INTRO_HANGUP_SECS);
    if (introHangup) {
        return connected("Cold", "Hung up during intro", "19", sip, {
            introHangupCounter: true,
            shortOpener: true,
        });
    }
    return connected("Cold", "Need Some Time", "20", sip, { manualReview: true });
}

/** Is the dial a person on the line? (the readout's "humans"). */
export function isHumanDisposition(d: Pick<DispositionV3, "l1" | "l2" | "rule">): boolean {
    if (d.l1 !== "Connected") return d.rule === "7"; // a person said "wrong number"
    return d.l2 !== "Machine";
}

// ── From raw call evidence ───────────────────────────────────────────────────

/** Everything a finalizer / failure path knows about one dial. */
export type DialEvidence = {
    /** classifyCallEnd() for this dial. */
    callEnd: { status: string; outcome?: string | null };
    failureText?: string | null;
    sipCode?: number | string | null;
    answeredBy?: string | null;
    callResult?: string | null;
    /** data collection callback_agreed (boolean, or "true" / "false" text). */
    callbackAgreed?: boolean | string | null;
    /** transcript analysis signals.callback_agreed === "yes". */
    analysisCallbackAgreed?: boolean | null;
    /** transcript analysis signals.callback_when (free text), if any. */
    analysisCallbackWhen?: string | null;
    callLanguage?: string | null;
    terminationReason?: string | null;
    durationSecs?: number | string | null;
    transcript?: string | null;
    /** campaignLeadStatus.dealerSpoke() — passed in to keep this module light. */
    dealerSpoke?: boolean | null;
};

/** "true" / "yes" / true → true; "false" / "no" / false → false; else null. */
export function parseFlag(v: boolean | string | null | undefined): boolean | null {
    if (typeof v === "boolean") return v;
    const t = (v ?? "").trim().toLowerCase();
    if (["true", "yes", "1"].includes(t)) return true;
    if (["false", "no", "0"].includes(t)) return false;
    return null;
}

function numberOrNull(v: number | string | null | undefined): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The mapper's input from raw evidence. Exported for tests and the backfill. */
export function dispositionInputFrom(e: DialEvidence): DispositionV3Input {
    const dc = parseFlag(e.callbackAgreed);
    // The agent's own data collection wins when it sent one; the transcript
    // analysis covers agents that do not (and is the only source on old rows).
    const callbackAgreed = dc ?? (e.analysisCallbackAgreed === true ? true : null);
    const askedToCallLater = callbackAgreed !== true && !!(e.analysisCallbackWhen ?? "").trim();
    return {
        callEndStatus: e.callEnd.status,
        callEndOutcome: e.callEnd.outcome ?? null,
        failureText: e.failureText ?? null,
        sipCode: extractSipCode(e.sipCode ?? null, e.failureText ?? null),
        answeredBy: e.answeredBy ?? null,
        callResult: e.callResult ?? null,
        callbackAgreed,
        askedToCallLater,
        callLanguage: e.callLanguage ?? null,
        languageFlip: languageFlipped(e.transcript, e.callLanguage),
        durationSecs: numberOrNull(e.durationSecs),
        endedBy: endedBy(e.terminationReason),
        dealerTurnsAfterOpener: dealerTurnsAfterOpener(e.transcript),
        dealerSpoke: e.dealerSpoke ?? null,
    };
}

/** mapDispositionV3(dispositionInputFrom(e)), with the derived inputs alongside. */
export function dispositionForDial(e: DialEvidence): { d: DispositionV3; input: DispositionV3Input } {
    const input = dispositionInputFrom(e);
    return { d: mapDispositionV3(input), input };
}
