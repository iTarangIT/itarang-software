/**
 * Reading a stored call transcript back into turns.
 *
 * WHY THIS EXISTS
 *   Four of the questions the campaign screen has to answer — did the dealer say
 *   anything, did the AI get past its opening line, was this a real exchange,
 *   which opening script performs best — are only answerable from the SHAPE of
 *   the conversation, not from its duration. That shape is stored as text.
 *
 * THE FORMAT THIS INVERTS
 *   `elevenlabs/getCallStatus.ts` and `elevenlabs/webhookHandler.ts` both
 *   stringify the provider's turn array the same way: one line per turn,
 *   `"<speaker>: <message>"`, joined by "\n", where speaker is `user`, `agent`,
 *   or the raw role lowercased for anything else. Each message is `.trim()`ed
 *   and nothing else — no escaping.
 *
 *   That last detail is the whole reason this is a parser rather than a
 *   `split("\n")`. A message containing a newline survives into the stored
 *   string, and a naive split reads its second half as a turn with no speaker.
 *   Every turn count downstream would then be wrong, in the direction of
 *   flattering us: more turns looks like more conversation. So a line with no
 *   recognised prefix is treated as a CONTINUATION of the turn above.
 *
 *   Measured across all 83 stored transcripts on 2026-08-24: zero continuation
 *   lines and zero non-agent/user speakers. The guards are for the case that has
 *   not happened yet, not one that has — which is exactly when a guard is cheap.
 *
 * PURE — no db import, no provider import. Everything here is a string
 * operation, so the arithmetic that decides "this campaign's opener is failing"
 * is unit-testable without a DATABASE_URL.
 */

export interface TranscriptTurn {
    /** "agent" | "user" | whatever role the provider sent, lowercased. */
    speaker: string;
    text: string;
}

/**
 * How much of the opening line identifies the SCRIPT.
 *
 * LOAD-BEARING, and the number was measured rather than picked. Fingerprinting
 * the same 83 transcripts at 60 characters produced 9 "variants"; at 20 it
 * produced 4. The extra five were one script truncated at different points —
 * the long key was measuring where the audio stopped, not which script ran, and
 * would have reported a script as "failing" purely because its calls dropped
 * early. Script identity and truncation are separate dimensions and are kept
 * separate: `greetingState` carries the truncation.
 *
 * The floor is set by how similar two real openers are. "नमस्ते sir! Priya बोल"
 * and "नमस्कार sir, Priya बोल" diverge at character 4, so 20 is far above the
 * minimum needed to tell the live scripts apart.
 */
export const FINGERPRINT_CHARS = 20;

/**
 * Lines the stringifiers can emit as a turn head.
 *
 * DELIBERATELY PERMISSIVE about the speaker, because the stringifiers are: they
 * emit `role === "user" ? "user" : role === "agent" ? "agent" : role`, so any
 * role the provider invents becomes a speaker. Matching only agent|user would
 * silently glue such a turn onto the one above it, which is the failure mode
 * that inflates a cut-off greeting into a complete one.
 *
 * The cost of permissiveness is the mirror case: a CONTINUATION line that
 * happens to begin `word:` ("EMI: 12 months") is read as a new turn. That is
 * bounded and cheap — a phantom speaker is neither `agent` nor `user`, so
 * userTurnCount and agentTurnCount are unaffected, and only a greeting with an
 * embedded newline could shift `greetingState`. Across all 83 stored
 * transcripts there are zero continuation lines and zero non-agent/user
 * speakers, so neither branch is exercised today.
 *
 * The {1,20} bound stops a whole sentence becoming a speaker name.
 */
const TURN_HEAD = /^([a-z0-9_-]{1,20}):[ ]?(.*)$/i;

/**
 * Terminal punctuation, including the Devanagari danda.
 *
 * A greeting that stops without one was cut off mid-sentence. This is a
 * HEURISTIC and is named as one wherever it surfaces: a script that genuinely
 * ends without punctuation reads as cut off, and a transcriber that drops a
 * final full stop does too.
 */
const SENTENCE_END = /[.?!।]$/;

/** An ellipsis is an explicit "this stopped", not an ending. */
const ELLIPSIS_END = /(\.\.\.|…)$/;

/**
 * Split a stored transcript into turns.
 *
 * Unprefixed leading lines are dropped rather than attributed to a guessed
 * speaker: there is no turn above them to continue, and inventing one would put
 * words in the dealer's mouth.
 */
export function parseTranscriptTurns(
    transcript: string | null | undefined,
): TranscriptTurn[] {
    if (!transcript) return [];

    const turns: TranscriptTurn[] = [];
    for (const line of transcript.split("\n")) {
        const head = TURN_HEAD.exec(line);
        if (head) {
            turns.push({ speaker: head[1].toLowerCase(), text: head[2] });
        } else if (turns.length > 0) {
            turns[turns.length - 1].text += "\n" + line;
        }
        // else: an unprefixed line before any turn. Nothing to attach it to.
    }

    // Trailing whitespace-only continuations are noise, not content. An empty
    // turn BODY is kept: the provider sent a turn, so a turn happened, and
    // dropping it would undercount whoever spoke.
    for (const turn of turns) turn.text = turn.text.replace(/\s+$/, "");

    return turns;
}

/** The agent's opening line, or null if the agent never spoke first. */
function openingTurn(turns: TranscriptTurn[]): TranscriptTurn | null {
    const first = turns[0];
    if (!first || first.speaker !== "agent") return null;
    return first;
}

/**
 * Did the AI finish its opening line?
 *
 * "absent"   — the agent never spoke, so there was no greeting to hear.
 * "complete" — the opening line reached terminal punctuation.
 * "cut_off"  — it stopped mid-sentence.
 *
 * JUDGES THE GREETING ALONE. A call that ran for ten turns and was severed at
 * the end still DELIVERED its greeting; rolling that into one "was the call cut
 * off" flag would conflate "the dealer never heard our pitch" with "we lost the
 * line during a working conversation", which are opposite problems.
 *
 * Why this matters on real data: of 51 transcripts where the agent spoke and
 * the dealer never did, 44 were cut off mid-greeting at a median of 7 seconds.
 * The dealer is not rejecting the pitch — the pitch is not arriving.
 */
export function greetingState(
    turns: TranscriptTurn[],
): "complete" | "cut_off" | "absent" {
    const opening = openingTurn(turns);
    if (!opening) return "absent";

    const text = opening.text.trim();
    if (!text) return "absent";

    if (ELLIPSIS_END.test(text)) return "cut_off";
    return SENTENCE_END.test(text) ? "complete" : "cut_off";
}

/**
 * A stable key for "which opening script was this".
 *
 * Normalises whitespace (so a re-wrapped message does not fork a script), strips
 * trailing ellipsis and full stops (so a truncated delivery keys the same as a
 * complete one), then takes FINGERPRINT_CHARS. See that constant for why the
 * length is what it is.
 *
 * Returns the fingerprint, not a hash: an operator reading the script table
 * needs to recognise the opener, and a hex digest identifies nothing to a human.
 */
export function openingFingerprint(turns: TranscriptTurn[]): string | null {
    const opening = openingTurn(turns);
    if (!opening) return null;

    const normalised = opening.text
        .replace(/\s+/g, " ")
        .replace(/(\.\.\.|…|\.)+$/, "")
        .trim();

    if (!normalised) return null;
    return normalised.slice(0, FINGERPRINT_CHARS);
}

/** Turns spoken by the dealer. The denominator-free primitive the funnel counts. */
export function userTurnCount(turns: TranscriptTurn[]): number {
    return turns.filter((t) => t.speaker === "user").length;
}

/** Turns spoken by the AI. */
export function agentTurnCount(turns: TranscriptTurn[]): number {
    return turns.filter((t) => t.speaker === "agent").length;
}
