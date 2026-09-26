// What a campaign call ENDED as — the vocabulary of dialer_campaign_leads.status
// and the one rule that picks it.
//
// WHY THIS EXISTS
//   completeCampaignLead used to be binary: `success ? "completed" : "failed"`,
//   and every finalizer passed success=true whenever the provider handed back ANY
//   transcript. A transcript exists whenever the AI spoke — into a ringback, a
//   carrier announcement, a voicemail greeting, or a line the dealer hung up on
//   before saying a word — so all of those were counted as Completed. On prod
//   (2026-09-21) ~480 of ~550 "Completed" rows were calls where the dealer never
//   said anything, and the busy / no-answer / rejected split was buried inside
//   `trigger_failed: …` strings. Campaign analytics were reporting dial attempts
//   as conversations.
//
//   Both providers document the trap. Bolna: "status: 'completed' does not mean
//   a conversation happened" — look for a `user:` line. ElevenLabs reports
//   busy / no-answer only through call_initiation_failure or SIP codes.
//
// THE RULE
//   Completed := the dealer spoke at least one real turn — a `user:` turn with
//   actual content that is not a carrier announcement ("the number you have
//   dialled is busy", "आप जिस नंबर से संपर्क करना चाहते हैं वह अभी व्यस्त है"),
//   on a call that was not answered by voicemail. Everything else is one of the
//   non-conversation statuses below, picked from the strongest evidence present.
//
//   The SAME rule backs the AI-connected hard block (exclusionFilter.ts), which
//   is why it has a SQL twin here: a lead the AI never actually spoke with must
//   not be permanently retired from AI redial because a greeting was logged.
//
// PURE — no db, no drizzle, no provider import. Imported by the finalizers, the
// dialer loop, the API routes AND the client-side status badge, so the label on
// a chip and the rule that assigned it cannot drift apart.

import { parseTranscriptTurns } from "./call-quality/transcript";
import {
    classifyProviderStatus,
    classifyTriggerDetail,
    type FailureReasonCode,
} from "./failureReason";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * Every value dialer_campaign_leads.status can hold. Free text in the DB (no
 * CHECK, no pgEnum — the E-202/E-228 convention); THIS list is the vocabulary.
 */
export const CAMPAIGN_LEAD_STATUSES = [
    "pending",
    "calling",
    "completed",
    "no_response",
    "busy",
    "rejected",
    "voicemail",
    "silent",
    "hung_up",
    "no_conversation",
    "failed",
    "skipped",
] as const;

export type CampaignLeadStatus = (typeof CAMPAIGN_LEAD_STATUSES)[number];

/** Where a call that was actually attempted can land. */
export const ATTEMPTED_STATUSES = [
    "completed",
    "no_response",
    "busy",
    "rejected",
    "voicemail",
    "silent",
    "hung_up",
    "no_conversation",
    "failed",
] as const satisfies readonly CampaignLeadStatus[];

export type CallEndStatus = (typeof ATTEMPTED_STATUSES)[number];

/** Attempted, but no conversation came of it. */
export const NON_CONVERSATION_STATUSES = [
    "no_response",
    "busy",
    "rejected",
    "voicemail",
    "silent",
    "hung_up",
    "no_conversation",
    "failed",
] as const satisfies readonly CampaignLeadStatus[];

/**
 * Rows the Retry / Recall flows may re-queue. `failed` is further narrowed by
 * isRetryableFailure (a config error is retryable, an invalid number is not).
 */
export const RETRYABLE_STATUSES = NON_CONVERSATION_STATUSES;

/** Finished rows — nothing moves a row out of these. */
export const TERMINAL_STATUSES = [
    ...ATTEMPTED_STATUSES,
    "skipped",
] as const satisfies readonly CampaignLeadStatus[];

/**
 * Display labels.
 *
 * `pending` reads "Queued": a lead not yet dialled.
 *
 * A call that connected without a conversation used to be ONE status,
 * `no_conversation`, shown as "Pending" (2026-09-21). That read like "not
 * dialled yet" and mixed three different outcomes, so since 2026-09-26 the
 * classifier splits it along the usual dialer dispositions (dead air vs early
 * abandon vs ring-no-answer):
 *   silent   "Silent Call"   — answered and listened, never said a word
 *   hung_up  "Hung Up Early" — answered, dropped during the greeting
 *   a 0-second no-transcript "completed" → no_response (never connected)
 * `no_conversation` stays in the vocabulary for rows the backfill could not
 * split; the classifier no longer writes it.
 */
export const CAMPAIGN_LEAD_STATUS_LABELS: Record<CampaignLeadStatus, string> = {
    pending: "Queued",
    calling: "Calling",
    completed: "Completed",
    no_response: "No Response",
    busy: "Busy",
    rejected: "Rejected",
    voicemail: "Voicemail",
    silent: "Silent Call",
    hung_up: "Hung Up Early",
    no_conversation: "Silent Call (legacy)",
    failed: "Failed",
    skipped: "Skipped",
};

export function isCampaignLeadStatus(s: unknown): s is CampaignLeadStatus {
    return (
        typeof s === "string" &&
        (CAMPAIGN_LEAD_STATUSES as readonly string[]).includes(s)
    );
}

export function campaignLeadStatusLabel(s: string | null | undefined): string {
    return isCampaignLeadStatus(s) ? CAMPAIGN_LEAD_STATUS_LABELS[s] : (s ?? "—");
}

/** `'a', 'b'` — for a raw-SQL `IN (…)`. Every member is a fixed literal above. */
export function sqlStatusList(statuses: readonly CampaignLeadStatus[]): string {
    return statuses.map((s) => `'${s}'`).join(", ");
}

// ── Carrier announcements ────────────────────────────────────────────────────
//
// On a SIP trunk in India an unanswered, busy or switched-off number is often
// ANSWERED by the carrier, which then plays a recorded message. The AI greets
// it, the transcriber writes the recording down as `user:` speech, and the call
// looks like the dealer talked. These phrases identify such a turn.
//
// Deliberately CARRIER-SPECIFIC. "busy", "व्यस्त", "बंद है" and "please call
// later" are all things a real dealer says ("abhi main busy hoon", "dukaan band
// hai") — matching on those alone would turn genuine conversations into Busy.
// So a turn counts as an announcement only when it carries a phrase no dealer
// would say to a sales call: the "number you have dialled" frame, or voicemail
// boilerplate. The KIND is then read from keywords inside that turn.
//
// Seeded from the published Jio / Airtel / Vi / BSNL messages and calibrated
// against stored transcripts by scripts/verify-campaign-lead-status.ts.

const ANNOUNCEMENT_FRAME_PHRASES = [
    // English
    "number you have dialled",
    "number you have dialed",
    "number you have called",
    "number you are calling",
    "number you're calling",
    "number you are trying",
    "person you are calling",
    "person you have reached",
    "customer you are calling",
    "subscriber you",
    "is currently switched off",
    "is switched off",
    "is not reachable",
    "is currently not reachable",
    "is out of coverage",
    "number does not exist",
    "number doesn't exist",
    "number is not in service",
    "not a valid number",
    // Hindi (Devanagari)
    "आप जिस नंबर",
    "आप जिस नम्बर",
    "जिस नंबर पर आप",
    "जिस नंबर से आप",
    "जिस नम्बर पर",
    "जिस व्यक्ति से",
    "संपर्क करना चाहते हैं",
    "सम्पर्क करना चाहते हैं",
    "डायल किया गया नंबर",
    "डायल किया हुआ नंबर",
    "नंबर मौजूद नहीं",
    // Hindi (romanised, as some transcribers emit it)
    "aap jis number",
    "jis number par",
    "jis number se",
    "sampark karna chahte",
] as const;

const VOICEMAIL_PHRASES = [
    "voicemail",
    "voice mail",
    "voice-mail",
    "leave a message",
    "leave your message",
    "after the beep",
    "after the tone",
    "at the tone",
    "record your message",
    "not available to take your call",
    "mailbox",
    "वॉइस मेल",
    "वॉयस मेल",
    "बीप के बाद",
    "संदेश छोड़",
] as const;

// A machine that is NOT the carrier picked up: a missed-call auto-reply, a
// call-screening assistant ("Thanks, please stay on the line"), or a business's
// IVR menu / hold message. The AI talks to it, the transcriber writes it down
// as `user:`, and — lacking the carrier frame above — it used to count as the
// dealer speaking. On camp_msr9dbh0_gwn04wcq (prod, 2026-08-13) that was 12 of
// 21 "Completed" calls, with the Voicemail card reading 0. All of these land in
// Voicemail: the call reached a machine, not the dealer.
//
// Same bar as the frame list: phrases a dealer would not say to a sales call.
// Seeded from that campaign, then widened against every prod transcript
// (926, 2026-09-22); the calibration tests pin each family.
const MACHINE_PHRASES = [
    // Missed-call auto-reply
    "your call went unanswered",
    "we have noted your number",
    "receive a call back shortly",
    // Call-screening assistant (Google / Samsung / carrier)
    "please stay on the line",
    "person is available",
    "screening service",
    "call assistant",
    "person you are trying to reach",
    "reason for calling",
    // IVR menus, hold and transfer messages
    "select any option",
    "please confirm the language",
    "please confirm language",
    "your call is important to us",
    "will attend to you shortly",
    "your call will be answered",
    "will be with you shortly",
    "please wait while we",
    "call is being transferred",
    "transferring your call",
    "thank you for calling",
    "thanks for calling",
    "be recorded for",
    "call is now being recorded",
    "did not receive any input",
    "didn't receive any input",
    // Hindi IVR. The transcriber writes "line" in Latin script as often as
    // "लाइन", and drops the anusvara (रहे / रहें), so both are the stem.
    "line पर बने रह",
    "लाइन पर बने रह",
    "input प्राप्त नहीं",
    "इनपुट प्राप्त नहीं",
    "record की जा सकती है",
    "के लिए कहें",
    "अन्य कोई सहायता",
    "कोई और सहायता",
] as const;

// IVR key prompts — "press 1", "press one", "2 दबाएँ", "दो दबाइए". Raw
// fragments, NOT escaped, so each must mean the same in a JS RegExp and a
// Postgres ARE: no \b (a backspace in ARE), no lookaround. `(^|[^a-z])` stands
// in for the word boundary so "Express 1 battery" is not a keypress.
const MACHINE_PATTERNS = [
    "(^|[^a-z])press ([0-9]|one|two|three|four|five|six|seven|eight|nine|zero)",
    "([0-9०-९]|एक|दो|तीन|चार|पांच|पाँच|छह|सात|आठ|नौ|शून्य) ?दबा",
] as const;

const BUSY_WORDS = ["busy", "another call", "व्यस्त", "बिज़ी", "बिजी", "दूसरी कॉल", "vyast", "dusri call"];
const INVALID_WORDS = [
    "does not exist",
    "doesn't exist",
    "not in service",
    "not a valid",
    "invalid",
    "incorrect",
    "मौजूद नहीं",
    "अमान्य",
    "गलत",
    "सही नहीं",
];

/** Escape for BOTH a JS RegExp and a Postgres ARE — same metacharacter set. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternation(phrases: readonly string[]): string {
    return phrases.map(escapeRegex).join("|");
}

const MACHINE_PATTERN = [alternation(MACHINE_PHRASES), ...MACHINE_PATTERNS].join("|");

/** The one pattern both twins test a dealer turn against. */
export const ANNOUNCEMENT_PATTERN = [
    alternation([...ANNOUNCEMENT_FRAME_PHRASES, ...VOICEMAIL_PHRASES]),
    MACHINE_PATTERN,
].join("|");

const ANNOUNCEMENT_RE = new RegExp(ANNOUNCEMENT_PATTERN, "i");
const FRAME_RE = new RegExp(alternation(ANNOUNCEMENT_FRAME_PHRASES), "i");
const VOICEMAIL_RE = new RegExp(alternation(VOICEMAIL_PHRASES), "i");
const BUSY_RE = new RegExp(alternation(BUSY_WORDS), "i");
const INVALID_RE = new RegExp(alternation(INVALID_WORDS), "i");

/**
 * At least one character that is not whitespace or punctuation.
 *
 * ElevenLabs writes `user: ...` for a turn where the dealer made a sound but
 * said nothing; that is not speech. Written as the ASCII punctuation ranges plus
 * "…" and the danda so it matches Postgres `[[:punct:]]` under a C locale, where
 * the class is ASCII-only — the SQL twin spells the same set.
 */
const CONTENT_RE = /[^\s!-\/:-@\[-`{-~…।]/;
const CONTENT_SQL_CLASS = "[^[:space:][:punct:]…।]";

export type AnnouncementKind = "busy" | "no_response" | "voicemail" | "invalid";

/** Is this dealer turn really a recording or a machine, and if so which kind? */
export function classifyCarrierAnnouncement(
    text: string | null | undefined,
): AnnouncementKind | null {
    if (!text || !ANNOUNCEMENT_RE.test(text)) return null;
    if (VOICEMAIL_RE.test(text)) return "voicemail";
    // Only the carrier frame decides busy / invalid / no-response. An IVR hold
    // saying "all our executives are busy" is a machine, not a busy line.
    if (FRAME_RE.test(text)) {
        if (BUSY_RE.test(text)) return "busy";
        if (INVALID_RE.test(text)) return "invalid";
        // Not answering / switched off / unreachable / out of coverage: in every
        // case the dealer was not reached, which is what No Response means.
        return "no_response";
    }
    // No frame, so a MACHINE_PHRASES / MACHINE_PATTERNS match: an auto-reply,
    // screening assistant or IVR answered instead of the dealer.
    return "voicemail";
}

type TranscriptReading = {
    /** At least one turn of any speaker. */
    anyTurn: boolean;
    /** At least one real dealer turn. */
    dealerSpoke: boolean;
    /** The first announcement found in a dealer turn, if any. */
    announcement: AnnouncementKind | null;
};

function readTranscript(transcript: string | null | undefined): TranscriptReading {
    const turns = parseTranscriptTurns(transcript);
    let dealerSpoke = false;
    let announcement: AnnouncementKind | null = null;
    for (const turn of turns) {
        if (turn.speaker !== "user" || !CONTENT_RE.test(turn.text)) continue;
        const kind = classifyCarrierAnnouncement(turn.text);
        if (kind) announcement ??= kind;
        else dealerSpoke = true;
    }
    return { anyTurn: turns.length > 0, dealerSpoke, announcement };
}

/** Did the dealer say anything real? The definition of "conversation started". */
export function dealerSpoke(transcript: string | null | undefined): boolean {
    return readTranscript(transcript).dealerSpoke;
}

/**
 * SQL twin of dealerSpoke(), for an ai_call_logs row aliased `alias`.
 *
 * Splits on newlines the way the stringifiers join turns. The one place it can
 * disagree with the JS reader is a message containing a newline (JS attaches the
 * continuation to the turn above); none exist in stored data, and
 * scripts/verify-campaign-lead-status.ts asserts the two agree row for row.
 */
export function dealerSpokeSql(alias: string): string {
    const pattern = ANNOUNCEMENT_PATTERN.replace(/'/g, "''");
    return (
        `EXISTS (SELECT 1 FROM regexp_split_to_table(${alias}.transcript, E'\\n') AS l(line)` +
        ` WHERE l.line ~* '^user: ?.*${CONTENT_SQL_CLASS}'` +
        ` AND l.line !~* '${pattern}')`
    );
}

// ── The classifier ───────────────────────────────────────────────────────────

export type CallEndEvidence = {
    /** Raw provider status: Bolna `status`, ElevenLabs `status`. */
    providerStatus?: string | null;
    /** The stored "speaker: message" transcript. */
    transcript?: string | null;
    /**
     * The dialer's own record of a failed placement — `trigger_failed: …`,
     * `trigger_exception: …`, or just the provider's error text.
     */
    triggerError?: string | null;
    /** ElevenLabs call_initiation_failure.failure_reason (busy | no-answer | unknown). */
    initiationFailureReason?: string | null;
    /** SIP response code from the initiation-failure metadata. */
    sipStatusCode?: number | string | null;
    /** Bolna telephony_data.answered_by_voice_mail. */
    answeredByVoicemail?: boolean | null;
    /** ElevenLabs metadata.termination_reason / Bolna hangup_reason. */
    terminationReason?: string | null;
    /** How long the call lasted, in seconds (ai_call_logs.call_duration). */
    durationSecs?: number | string | null;
};

export type CallEndClassification = {
    status: CallEndStatus;
    /**
     * Set only when the classification knows something the caller's outcome
     * string does not — e.g. "invalid_number" from a carrier announcement.
     * Callers keep their own outcome otherwise.
     */
    outcome: string | null;
};

const VOICEMAIL_TERMINATION = /voice ?mail|answering machine|machine detected|machine_detected/i;

/**
 * A termination reason saying the OTHER side ended the call — the dealer hung
 * up, not our agent. ElevenLabs writes "Call ended by remote party" / "client
 * disconnected"; Bolna's hangup_reason says "user hangup" / "customer hung up".
 */
const REMOTE_HANGUP_TERMINATION =
    /remote party|client disconnected|(?:user|customer|callee)[ _-]?(?:hung[ _-]?up|hangup|ended|disconnected)|hung[ _-]?up by (?:user|customer)/i;

/**
 * An answered call the dealer dropped before this many seconds is "Hung Up
 * Early" — they cut the greeting off. Past it they heard the pitch and stayed
 * silent: "Silent Call". Check against the duration histogram the backfill
 * prints (scripts/backfill-campaign-lead-status.ts) before changing it.
 */
export const EARLY_HANGUP_SECS = 10;

function seconds(v: number | string | null | undefined): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Answered, but the dealer never spoke: which of the two was it? */
function silentOrHungUp(e: CallEndEvidence): "silent" | "hung_up" {
    const d = seconds(e.durationSecs);
    // No duration: only a remote-hangup reason can say "early".
    if (d == null) {
        return REMOTE_HANGUP_TERMINATION.test(e.terminationReason ?? "") ? "hung_up" : "silent";
    }
    return d < EARLY_HANGUP_SECS ? "hung_up" : "silent";
}

function statusForReason(code: FailureReasonCode): CallEndStatus | null {
    switch (code) {
        case "busy":
            return "busy";
        case "not_answered":
            return "no_response";
        case "rejected":
            return "rejected";
        case "voicemail":
            return "voicemail";
        case "invalid_number":
        case "technical":
        case "config_error":
        case "disconnected":
            return "failed";
        default:
            return null;
    }
}

function telephonyText(e: CallEndEvidence): string {
    const parts = [e.triggerError, e.initiationFailureReason];
    if (e.sipStatusCode != null && `${e.sipStatusCode}`.trim()) {
        parts.push(`sip status: ${e.sipStatusCode}`);
    }
    return parts
        .filter((p): p is string => typeof p === "string" && p.trim() !== "")
        .join(" ")
        .replace(/^trigger_(?:failed|exception):?\s*/i, "")
        .replace(/no-answer/gi, "no answer");
}

/**
 * The status a finished call attempt lands in.
 *
 * Evidence order, strongest first:
 *   1. The provider flagged voicemail.
 *   2. The dealer spoke            → completed.
 *   3. A carrier announcement      → busy / no_response / voicemail / failed.
 *   4. A telephony failure (trigger error, initiation failure, SIP code).
 *   5. The AI spoke into a line nobody answered in words → silent / hung_up
 *      (by how long the dealer stayed on the line).
 *   6. The raw provider status ("completed" with nothing exchanged: 0s is
 *      no_response, otherwise silent / hung_up).
 *   7. failed.
 */
export function classifyCallEnd(e: CallEndEvidence): CallEndClassification {
    if (e.answeredByVoicemail === true || VOICEMAIL_TERMINATION.test(e.terminationReason ?? "")) {
        return { status: "voicemail", outcome: null };
    }

    const reading = readTranscript(e.transcript);
    if (reading.dealerSpoke) return { status: "completed", outcome: null };

    switch (reading.announcement) {
        case "busy":
            return { status: "busy", outcome: null };
        case "no_response":
            return { status: "no_response", outcome: null };
        case "voicemail":
            return { status: "voicemail", outcome: null };
        case "invalid":
            return { status: "failed", outcome: "invalid_number" };
    }

    const telephony = telephonyText(e);
    if (telephony) {
        const status = statusForReason(classifyTriggerDetail(telephony));
        if (status) return { status, outcome: null };
    }

    // The line connected and the AI spoke, but no dealer turn followed.
    if (reading.anyTurn) return { status: silentOrHungUp(e), outcome: null };

    const provider = (e.providerStatus ?? "").trim().toLowerCase();
    if (provider) {
        // Finished "normally" with nothing exchanged. ElevenLabs DEFAULTS a
        // missing status to "completed" (normalizePostCall), so one with no
        // transcript and 0 seconds never connected: a ring-out, not silence.
        // With a duration the line was open, so silent / hung up.
        if (["completed", "done", "ended"].includes(provider)) {
            const d = seconds(e.durationSecs);
            if (d === 0 || (d == null && !e.terminationReason)) {
                return { status: "no_response", outcome: null };
            }
            return { status: silentOrHungUp(e), outcome: null };
        }
        const status = statusForReason(classifyProviderStatus(provider));
        if (status) return { status, outcome: null };
    }

    return { status: "failed", outcome: null };
}

// ── Re-classifying a stored row ──────────────────────────────────────────────

export type StoredAttempt = {
    /** dialer_campaign_leads.status as stored. */
    status: string;
    /** dialer_campaign_leads.call_outcome. */
    callOutcome: string | null;
    /** ai_call_logs.transcript for this attempt, if a log row exists. */
    transcript: string | null;
    /** ai_call_logs.status — the raw provider status, if a log row exists. */
    providerStatus: string | null;
    /** ai_call_logs.call_duration, seconds. */
    durationSecs?: number | string | null;
    /** ai_call_logs.end_reason (E-310) — null on rows written before it. */
    endReason?: string | null;
};

/**
 * What a row written before classifyCallEnd existed SHOULD read.
 *
 * Returns null for rows that are not a finished attempt (pending / calling),
 * which a backfill must never touch. Otherwise returns the classification the
 * finalizers would write today, from the evidence the row kept: the transcript
 * and provider status on its ai_call_logs row, and whatever the dialer wrote
 * into call_outcome (a trigger error, an initiation-failure reason, a raw
 * provider status, or the analyzer's outcome).
 *
 * Idempotent by construction — a row already carrying the new vocabulary
 * re-classifies to itself — so the backfill can be re-run safely.
 */
export type StoredClassification = {
    status: CallEndStatus | "skipped";
    outcome: string | null;
};

export function reclassifyStoredAttempt(a: StoredAttempt): StoredClassification | null {
    if (a.status === "pending" || a.status === "calling") return null;

    const outcome = (a.callOutcome ?? "").trim();
    const lower = outcome.toLowerCase();

    // Never dialled. Written as 'failed' before, 'skipped' now.
    if (lower === "no_phone" || lower.startsWith("ineligible")) {
        return { status: "skipped", outcome: null };
    }
    // Our own terminal outcomes with nothing to re-read — unless a transcript
    // turned up afterwards, in which case the call did happen.
    if ((lower === "stopped_by_user" || lower === "no_webhook") && !a.transcript) {
        return { status: "failed", outcome: null };
    }
    if (lower === "invalid_number") return { status: "failed", outcome: "invalid_number" };

    if (/^trigger_(failed|exception)/.test(lower)) {
        return classifyCallEnd({
            triggerError: outcome,
            transcript: a.transcript,
            durationSecs: a.durationSecs,
            terminationReason: a.endReason,
        });
    }

    return classifyCallEnd({
        transcript: a.transcript,
        durationSecs: a.durationSecs,
        terminationReason: a.endReason,
        // The log's status is the provider's own word. Without a log row, a
        // no-transcript finalize stored the provider status (or an ElevenLabs
        // initiation-failure reason) as the outcome — use that.
        providerStatus: a.providerStatus ?? (a.transcript ? null : outcome || null),
        initiationFailureReason:
            !a.providerStatus && !a.transcript && /busy|no[-_ ]?answer/.test(lower) ? outcome : null,
    });
}
