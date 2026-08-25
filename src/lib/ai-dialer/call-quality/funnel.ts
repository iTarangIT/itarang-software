/**
 * Where in the call are we losing dealers, and which opening line loses fewest?
 *
 * THE SHAPE OF THE ANSWER, AND WHY IT IS NOT ONE FUNNEL
 *   A funnel implies one population narrowing. This one cannot be, because the
 *   evidence changes partway down. Duration and outcome exist for every lead;
 *   a TRANSCRIPT exists for 28% of them; an intent SCORE exists for 2%. Drawing
 *   those as one column would report "2% of calls qualify" when the truth is
 *   "we almost never score a call". So there are three denominators and each
 *   stage carries its own — see `CallQualityFunnel`.
 *
 *   This is the same discipline as the duration panel's denominator note: three
 *   numbers on one screen may legitimately disagree, and the fix is to say so in
 *   words, not to force them into agreement.
 *
 * THE HEADLINE IS THE GREETING, NOT THE FUNNEL
 *   Measured on 83 stored transcripts: 51 are a single turn — the AI speaks, the
 *   dealer never does. Of those 51, forty-four were CUT OFF mid-sentence at a
 *   median of seven seconds. The dealer is not rejecting the pitch; the pitch is
 *   not arriving. A funnel phrased as "% reaching the first question" hides that
 *   behind one low percentage, so `greeting` is reported separately and first.
 *
 * PURE — no db import. The endpoint does the SQL, this does the arithmetic, and
 * every percentage the UI shows is therefore unit-testable without a
 * DATABASE_URL. Same split as call-duration/histogram.ts.
 */
import { deriveFailureReason, type FailureReasonCode } from "../failureReason";
import { isCallConnected } from "../call-duration/derive";
import {
    agentTurnCount,
    greetingState,
    openingFingerprint,
    parseTranscriptTurns,
    userTurnCount,
    type TranscriptTurn,
} from "./transcript";

/** One campaign lead joined to its authoritative ai_call_logs row. */
export interface CallQualityRow {
    /** dialer_campaign_leads.status */
    status: string | null;
    /** dialer_campaign_leads.call_outcome */
    callOutcome: string | null;
    /** ai_call_logs.call_duration — the PROVIDER's talk time, never wall clock. */
    providerDurationSeconds: number | string | null;
    transcript: string | null;
    /** ai_call_logs.info_signals_count — 0..5 disclosed facts, E-168. */
    infoSignalsCount: number | null;
    /**
     * E-267 — ai_call_logs.transcript_turns, the provider's array VERBATIM.
     *
     * Optional because the column may not exist yet: E-267 is deliberately
     * skippable (see the migration), so the endpoint omits this from its SELECT
     * on a database without it and every row arrives undefined. Absent is a
     * first-class state here, not a defect — it means "not collected", which the
     * UI must say rather than rendering a confident zero.
     */
    transcriptTurns?: unknown;
}

export interface OpeningScriptStat {
    /** The opening words themselves, not a hash — an operator has to recognise it. */
    fingerprint: string;
    calls: number;
    dealerSpoke: number;
    pastOpener: number;
    /** Mean provider talk time across this script's calls, or null. */
    averageSeconds: number | null;
    /** How often the greeting finished. A script is not failing if it never plays. */
    greetingCompleted: number;
}

export interface CallQualityFunnel {
    // ── Population 1: every lead. Duration + outcome exist for all of them. ──
    /** status <> 'pending' — we took it off the queue. */
    attempted: number;
    /** The provider actually placed it. Excludes our own misconfiguration. */
    dialled: number;
    /** A dealer picked up: Phase 1's rule — transcript OR provider talk time. */
    answered: number;

    // ── Population 2: the calls we stored a transcript for. ─────────────────
    withTranscript: number;
    dealerSpoke: number;
    pastOpener: number;
    meaningfulConversation: number;

    // ── Population 3: the calls an intent score was computed for. ───────────
    scored: number;
    qualified: number;

    /** The mid-greeting cliff — reported first in the UI, see the header. */
    greeting: {
        complete: number;
        cutOff: number;
        /** Cut off AND the dealer never spoke: the pitch never landed. */
        cutOffBeforeDealerSpoke: number;
        /**
         * Heard the WHOLE greeting and still said nothing.
         *
         * The counterpart to cutOffBeforeDealerSpoke, and the two must not be
         * merged. A dealer cut off mid-sentence never heard the offer, so the
         * fault is telephony; a dealer who heard it all and stayed silent
         * rejected what they heard, so the fault is the script. On live data
         * these are 44 and 7 — reporting only the larger one sends someone to
         * rewrite a script that is not being played.
         */
        completeThenSilent: number;
        medianCutOffSeconds: number | null;
    };

    /**
     * How long a CONVERSATION ran — calls where the dealer actually spoke.
     *
     * Its own population, and that is the whole point. The duration strip's
     * "Average call" is a mean over every measured call, which on live data is
     * 32s: a blend of 52s conversations and 9s calls nobody answered. That
     * number is not wrong, but it answers "how long is a call", not "how long
     * is a conversation", and the two differ by 63%. Reporting only the blend
     * understates every real exchange by twenty seconds.
     *
     * `measured` is the denominator: a dealer can speak on a call the provider
     * never reported a duration for, and those are counted in `dealerSpoke` but
     * cannot appear here.
     */
    conversation: {
        measured: number;
        averageSeconds: number | null;
        medianSeconds: number | null;
    };

    /**
     * How long a dealer stayed on the line before hanging up without speaking.
     *
     * Needs per-turn timings, which only exist from E-267 onward — every call
     * finalized before it was flattened to text and its timings are gone. So
     * `measured` is its own denominator and is expected to be 0 until new calls
     * accrue. Zero measured is "not collected yet", NOT "nobody hangs up", and
     * the UI is required to say which.
     */
    responseTime: {
        measured: number;
        medianSecondsBeforeHangUp: number | null;
    };

    /** Descending by dealer-reply rate, then by call count. */
    openingScripts: OpeningScriptStat[];
}

/**
 * Failure codes that PROVE the call reached the telephone network.
 *
 * A busy tone or an unanswered ring means the dialer worked and the dealer did
 * not pick up. Everything else a trigger failure can mean — a bad API key, a
 * from_number that does not exist, an unroutable agent — means no phone ever
 * rang, and counting those as "dialled" turns our own outage into a story about
 * dealers ignoring us. That inversion is exactly what the duration histogram was
 * doing before Phase 1.
 */
const REACHED_NETWORK: ReadonlySet<FailureReasonCode> = new Set<FailureReasonCode>([
    "busy",
    "not_answered",
    "voicemail",
    "disconnected",
]);

/** Failure codes that mean we never placed the call, whatever the wording. */
const NEVER_PLACED: ReadonlySet<FailureReasonCode> = new Set<FailureReasonCode>([
    "config_error",
    "ineligible",
    "stopped",
]);

/** E-168: three disclosed facts is the qualification bar. */
const QUALIFYING_SIGNALS = 3;

/** A dealer turn count that separates a real exchange from a brush-off. */
const MEANINGFUL_USER_TURNS = 3;

function toSeconds(v: number | string | null | undefined): number | null {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Linear-interpolated median, matching percentile_cont(0.5) in Postgres. */
function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = (s.length - 1) / 2;
    const lo = Math.floor(mid);
    const hi = Math.ceil(mid);
    return lo === hi ? s[lo] : Math.round((s[lo] + s[hi]) / 2);
}

/**
 * When the AI's last turn began, in seconds into the call.
 *
 * Reads the RAW provider array rather than our parsed turns, because the
 * timings only exist there: the `"<speaker>: <message>"` stringifier drops
 * `time_in_call_secs` on the floor, which is the entire reason E-267 exists.
 *
 * Defensive about shape on purpose. This array is stored VERBATIM, so it is
 * whatever the provider sent — including, on a bad day, objects with no timing
 * at all. Anything unusable yields null and the call is simply not measured,
 * which is honest; guessing a timing would put a fabricated number under a
 * heading that reads like a measurement.
 */
function lastAgentTurnStart(raw: unknown): number | null {
    if (!Array.isArray(raw)) return null;
    let latest: number | null = null;
    for (const turn of raw) {
        if (turn === null || typeof turn !== "object") continue;
        const t = turn as { role?: unknown; time_in_call_secs?: unknown };
        if (String(t.role ?? "").toLowerCase() !== "agent") continue;
        if (typeof t.time_in_call_secs !== "number") continue;
        if (!Number.isFinite(t.time_in_call_secs)) continue;
        if (latest === null || t.time_in_call_secs > latest) latest = t.time_in_call_secs;
    }
    return latest;
}

/**
 * Did the provider place this call?
 *
 * `trigger_failed` in any form means the TRIGGER failed, so the default is "no".
 * The detail can overturn that: a SIP 486 arrives only because the network was
 * reached. Non-trigger failures (a raw provider status like `busy`) were placed
 * by definition — the provider is reporting on a call it made.
 */
function wasDialled(row: CallQualityRow, hasTranscript: boolean): boolean {
    const reason = deriveFailureReason({
        status: row.status,
        callOutcome: row.callOutcome,
        hasTranscript,
    });
    if (!reason) return true; // no failure to explain: it happened
    if (NEVER_PLACED.has(reason.code)) return false;

    const isTriggerFailure = /^trigger_(failed|exception)/i.test(
        (row.callOutcome ?? "").trim(),
    );
    if (!isTriggerFailure) return true;
    return REACHED_NETWORK.has(reason.code);
}

export function buildCallQualityFunnel(rows: CallQualityRow[]): CallQualityFunnel {
    let attempted = 0;
    let dialled = 0;
    let answered = 0;
    let withTranscript = 0;
    let dealerSpoke = 0;
    let pastOpener = 0;
    let meaningfulConversation = 0;
    let scored = 0;
    let qualified = 0;

    let greetingComplete = 0;
    let greetingCutOff = 0;
    let cutOffBeforeDealerSpoke = 0;
    let completeThenSilent = 0;
    const cutOffDurations: number[] = [];
    const hangUpIntervals: number[] = [];
    const conversationDurations: number[] = [];

    const scripts = new Map<string, OpeningScriptStat & { _secs: number[] }>();

    for (const row of rows) {
        if ((row.status ?? "") === "pending") continue;
        attempted++;

        const hasTranscript = row.transcript != null && row.transcript.trim() !== "";
        if (wasDialled(row, hasTranscript)) dialled++;

        const duration = toSeconds(row.providerDurationSeconds);
        if (!isCallConnected({ hasTranscript, providerDurationSeconds: row.providerDurationSeconds })) {
            continue;
        }
        answered++;

        if (!hasTranscript) continue;
        withTranscript++;

        const turns: TranscriptTurn[] = parseTranscriptTurns(row.transcript);
        const userTurns = userTurnCount(turns);
        const agentTurns = agentTurnCount(turns);

        if (userTurns >= 1) {
            dealerSpoke++;
            // A conversation's length, kept apart from a call's length. See the
            // `conversation` field for why the two must not be averaged together.
            if (duration != null) conversationDurations.push(duration);
        }
        if (agentTurns >= 2) pastOpener++;
        if (userTurns >= MEANINGFUL_USER_TURNS) meaningfulConversation++;

        const greeting = greetingState(turns);
        if (greeting === "complete") {
            greetingComplete++;
            // Heard the whole offer and said nothing. See completeThenSilent.
            if (userTurns === 0) completeThenSilent++;
        } else if (greeting === "cut_off") {
            greetingCutOff++;
            if (userTurns === 0) {
                cutOffBeforeDealerSpoke++;
                if (duration != null) cutOffDurations.push(duration);
            }
        }

        // How long the dealer stayed after the AI stopped talking, on calls they
        // never answered. Measured only where BOTH ends are known: a real turn
        // timing (E-267) and a provider duration. A non-positive interval means
        // the two disagree — a timing past the end of the call — and is dropped
        // rather than clamped, because a clamped zero would read as "hung up
        // instantly" when the truth is "we do not know".
        if (userTurns === 0 && duration != null) {
            const lastAgentAt = lastAgentTurnStart(row.transcriptTurns);
            if (lastAgentAt != null) {
                const waited = Math.round(duration - lastAgentAt);
                if (waited > 0) hangUpIntervals.push(waited);
            }
        }

        const fingerprint = openingFingerprint(turns);
        if (fingerprint) {
            const stat =
                scripts.get(fingerprint) ??
                {
                    fingerprint,
                    calls: 0,
                    dealerSpoke: 0,
                    pastOpener: 0,
                    averageSeconds: null,
                    greetingCompleted: 0,
                    _secs: [],
                };
            stat.calls++;
            if (userTurns >= 1) stat.dealerSpoke++;
            if (agentTurns >= 2) stat.pastOpener++;
            if (greeting === "complete") stat.greetingCompleted++;
            if (duration != null) stat._secs.push(duration);
            scripts.set(fingerprint, stat);
        }

        // Scored is its OWN population — see the header. A null here means we
        // never ran the extraction, not that the dealer disclosed nothing.
        if (row.infoSignalsCount != null) {
            scored++;
            if (row.infoSignalsCount >= QUALIFYING_SIGNALS) qualified++;
        }
    }

    const openingScripts: OpeningScriptStat[] = [...scripts.values()]
        .map(({ _secs, ...stat }) => ({
            ...stat,
            averageSeconds: _secs.length
                ? Math.round(_secs.reduce((s, x) => s + x, 0) / _secs.length)
                : null,
        }))
        .sort((a, b) => {
            const rateA = a.calls > 0 ? a.dealerSpoke / a.calls : 0;
            const rateB = b.calls > 0 ? b.dealerSpoke / b.calls : 0;
            return rateB - rateA || b.calls - a.calls;
        });

    return {
        attempted,
        dialled,
        answered,
        withTranscript,
        dealerSpoke,
        pastOpener,
        meaningfulConversation,
        scored,
        qualified,
        greeting: {
            complete: greetingComplete,
            cutOff: greetingCutOff,
            cutOffBeforeDealerSpoke,
            completeThenSilent,
            medianCutOffSeconds: median(cutOffDurations),
        },
        conversation: {
            measured: conversationDurations.length,
            averageSeconds: conversationDurations.length
                ? Math.round(
                      conversationDurations.reduce((sum, x) => sum + x, 0) /
                          conversationDurations.length,
                  )
                : null,
            medianSeconds: median(conversationDurations),
        },
        responseTime: {
            measured: hangUpIntervals.length,
            medianSecondsBeforeHangUp: median(hangUpIntervals),
        },
        openingScripts,
    };
}
