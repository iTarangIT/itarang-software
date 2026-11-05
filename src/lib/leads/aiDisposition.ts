// An AI call → the CC team's L1/L2/L3 disposition.
//
// WHY IT LIVES HERE, next to dispositions.ts rather than under lib/ai/. Same
// reason that file gives for itself: the vocabulary describes WHAT HAPPENED ON A
// CALL, not who dialled it. A rep, a NeoDove agent and the robot all produce the
// same kind of fact, and they should all express it in the same words.
//
// This module is pure — no db, no I/O — so it can be exhaustively tested against
// the whole cross-product of inputs. The test is the interesting part: it
// asserts mechanically that every label this ever emits is a member of the
// sheet, which is what stops the AI quietly inventing a vocabulary of its own.
//
// Type-only imports, taken DIRECTLY from the scoring modules rather than through
// the @/lib/ai/scoring barrel — that barrel re-exports values and pulls zod in
// with them, which is the same discipline CampaignLeadTranscriptDrawer states.

import type { Band, CallStatus as BandCallStatus } from "@/lib/ai/scoring/computeBand";
import type { CallbackTopic, Disqualifier } from "@/lib/ai/scoring/signals";
import type { CallStatus } from "@/lib/lifecycle/touchpointTypes";
import { dealerSpoke } from "@/lib/ai-dialer/campaignLeadStatus";
import {
    callStatusForDisposition,
    classifyDisposition,
    type ConnectStatus,
    type DispositionBucket,
} from "@/lib/leads/dispositions";

export type AiCallDispositionInput = {
    /** ai_call_logs.transcript. */
    transcript: string | null;
    /**
     * B5 / D2 — classifyCallEnd().status for this call, THE connected gate:
     * only 'completed' (a person spoke) is connected. A switchboard, voicemail
     * greeting or the AI's own hello into silence leaves a transcript too, and
     * counting "has a transcript" as connected inflated the CEO connect rate.
     * Absent → dealerSpoke(transcript), the same rule from the text alone.
     */
    callEndStatus?: string | null;
    /**
     * classifyCallEnd().outcome — what the classifier learned that the status
     * does not say: out_of_service, invalid_number, early_hangup.
     */
    callOutcome?: string | null;
    /** ai_call_logs.status — the raw provider status string. */
    providerStatus: string | null;
    /** analyzeTranscript() returned {status:"failed"} — a call we cannot read. */
    analysisFailed?: boolean;
    band?: Band | null;
    bandCallStatus?: BandCallStatus | null;
    infoSignalsCount?: number | null;
    disqualifier?: Disqualifier | null;
    callbackAgreed?: boolean | null;
    relevantDealer?: boolean | null;
    pitchHeard?: boolean | null;
    /** signals.callback_topic — a complaint is a service matter, not intent. */
    callbackTopic?: CallbackTopic | null;
};

/** Which rule fired. A test key and a structured log key; never persisted. */
export type AiDispositionReason =
    | "nc:no_answer"
    | "nc:busy"
    | "nc:rejected"
    | "nc:invalid_number"
    | "nc:switched_off"
    | "nc:unreachable"
    | "nc:failed"
    | "nc:unknown"
    | "nc:no_person"
    | "nc:early_hangup"
    | "c:analysis_failed"
    | "c:not_analysed"
    | "c:dropped_empty"
    | "c:irrelevant"
    | "c:disqualified"
    | "c:callback_only"
    | "c:qualified"
    | "c:warm_callback"
    | "c:cold_details"
    | "c:complaint"
    | "c:substance"
    | "c:short_hangup"
    | "c:no_disclosure";

export type AiCallDisposition = {
    connectStatus: ConnectStatus;
    bucket: DispositionBucket | null;
    /**
     * ALWAYS a label that exists in dispositions.ts, or null.
     *
     * Null is not a failure — it is the honest answer for the two connected
     * cases the sheet has no words for (see C1/C8 below). The touchpoint still
     * records connect_status = 'connected', so the fact of the conversation is
     * never lost; only the L3 label is withheld.
     */
    disposition: string | null;
    /** The 5-value lead_touchpoints.call_status, derived from the L3. */
    callStatus: CallStatus;
    reasonCode: AiDispositionReason;
};

// ── Not connected ─────────────────────────────────────────────────────────
//
// Provider status strings vary by vendor and by year, so they are normalised
// before matching: "no-answer", "NO ANSWER" and "no_answer" are one key.

function normalizeStatus(raw: string | null): string {
    return (raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
}

const NOT_CONNECTED_RULES: {
    reason: AiDispositionReason;
    statuses: string[];
    label: string;
}[] = [
    {
        reason: "nc:no_answer",
        statuses: ["no_answer", "noanswer", "voicemail", "machine_detected", "answering_machine"],
        label: "Did not pick",
    },
    { reason: "nc:busy", statuses: ["busy", "user_busy"], label: "Busy in another call" },
    {
        reason: "nc:rejected",
        statuses: ["rejected", "declined", "call_rejected"],
        label: "User disconnected the call",
    },
    {
        reason: "nc:invalid_number",
        statuses: ["invalid_number", "wrong_number", "unallocated_number", "number_invalid"],
        label: "Incorrect / Invalid number",
    },
    {
        reason: "nc:switched_off",
        statuses: ["switched_off", "switch_off", "power_off", "subscriber_off"],
        label: "Switch off",
    },
    {
        reason: "nc:unreachable",
        statuses: ["unreachable", "out_of_coverage", "network_error", "no_route"],
        label: "Out of Coverage area / Network issue",
    },
    {
        reason: "nc:failed",
        // `completed` / `done` land here ON PURPOSE. A provider that says the
        // call finished while handing us no transcript has described, from the
        // CRM's point of view, a call that "can not be completed".
        statuses: [
            "failed",
            "error",
            "initiation_failure",
            "call_disconnected",
            "no_transcript",
            "completed",
            "done",
        ],
        label: "Call not connected / can not be completed",
    },
];

// ── The mapper ────────────────────────────────────────────────────────────

export function mapAiCallToDisposition(
    input: AiCallDispositionInput,
): AiCallDisposition {
    const connected = input.callEndStatus
        ? input.callEndStatus === "completed"
        : dealerSpoke(input.transcript);

    if (connected) return connectedDisposition(input);
    const byEnd = notConnectedByCallEnd(input);
    if (byEnd) return byEnd;
    // Answered, no person: a machine, a switchboard or a silent line. The
    // sheet has no "machine" label; nobody picked up is the truthful one.
    if (input.transcript && input.transcript.trim() !== "") {
        return {
            connectStatus: "not_connected",
            bucket: null,
            disposition: "Did not pick",
            callStatus: callStatusFor("Did not pick", "not_connected"),
            reasonCode: "nc:no_person",
        };
    }
    return notConnected(input);
}

/**
 * 3 Nov 2026 — the campaign row's own verdict names the reason more exactly
 * than the raw provider status: an Early Hang-up, a switched-off phone, a busy
 * line, a dead number. null → fall back to the transcript / provider rules.
 */
function notConnectedByCallEnd(input: AiCallDispositionInput): AiCallDisposition | null {
    const status = input.callEndStatus ?? "";
    const outcome = (input.callOutcome ?? "").toLowerCase();
    const nc = (label: string, reasonCode: AiDispositionReason): AiCallDisposition => ({
        connectStatus: "not_connected",
        bucket: null,
        disposition: label,
        callStatus: callStatusFor(label, "not_connected"),
        reasonCode,
    });
    if (outcome === "invalid_number") return nc("Incorrect / Invalid number", "nc:invalid_number");
    if (status === "hung_up") return nc("User disconnected the call", "nc:early_hangup");
    if (status === "no_response" && outcome === "out_of_service") return nc("Switch off", "nc:switched_off");
    if (status === "busy") return nc("Busy in another call", "nc:busy");
    if (status === "rejected") return nc("User disconnected the call", "nc:rejected");
    return null;
}

function notConnected(input: AiCallDispositionInput): AiCallDisposition {
    const status = normalizeStatus(input.providerStatus);
    const rule = NOT_CONNECTED_RULES.find((r) => r.statuses.includes(status));

    // "canceled"/"stopped"/anything unrecognised. "Other reason" is the sheet's
    // own catch-all and is the truthful answer — external_stage keeps the raw
    // status so a mis-mapping is diagnosable without re-reading ai_call_logs.
    const label = rule?.label ?? "Other reason";
    const reasonCode = rule?.reason ?? "nc:unknown";

    return {
        connectStatus: "not_connected",
        bucket: null,
        disposition: label,
        callStatus: callStatusFor(label, "not_connected"),
        reasonCode,
    };
}

function connectedDisposition(
    input: AiCallDispositionInput,
): AiCallDisposition {
    const connected = (
        disposition: string | null,
        bucket: DispositionBucket | null,
        reasonCode: AiDispositionReason,
    ): AiCallDisposition => ({
        connectStatus: "connected",
        bucket,
        disposition,
        callStatus: "connected",
        reasonCode,
    });

    // C1 — we reached the dealer but could not read the call. No connected
    // label in the sheet says "we don't know what was said", and every candidate
    // ("Need Some Time", "No requirement in current") would attribute a
    // statement the dealer never made. Null is the honest answer, and it is
    // informative: COUNT(*) WHERE connect_status='connected' AND disposition IS
    // NULL is a direct in-CRM measure of the extraction-failure rate.
    if (input.analysisFailed) return connected(null, null, "c:analysis_failed");

    // C1b — a transcript with NO analysis attached at all. Distinct from C1: the
    // analyser did not fail, it never ran. Historically this is every call that
    // predates the band engine, and it is the single largest group in the
    // backfill (73 of 125 on database-1).
    //
    // It needs its own rule because the fall-through would otherwise reach C8
    // and describe these as "sat through the pitch and disclosed nothing" — a
    // claim about the DEALER's behaviour, inferred from the absence of our own
    // data. Same null label as C1, but the reason code and the timeline remark
    // tell the truth about which one happened.
    if (
        input.band == null &&
        input.bandCallStatus == null &&
        input.relevantDealer == null &&
        input.pitchHeard == null &&
        (input.disqualifier == null || input.disqualifier === "none") &&
        !input.infoSignalsCount
    ) {
        return connected(null, null, "c:not_analysed");
    }

    // C2 — picked up, nothing of substance said. The sheet has exactly the right
    // words for this and files them under Cold.
    if (input.bandCallStatus === "dropped_empty") {
        return connected("Hung up during intro", "Cold", "c:dropped_empty");
    }

    // 3 Nov 2026 — when the band engine ran, the L2 bucket FOLLOWS THE BAND, so
    // the touchpoint and the lead tell the same story: Qualified → Hot, Warm →
    // Warm, Cold → Cold, Disqualified / a firm no → Lost. It used to be read from
    // relevant_dealer / pitch_heard, which the finalizers pass as `=== "yes"`:
    // a dealer who never named his product lines was filed "Some other
    // Business" (Lost) while his band said Cold or Warm.
    if (input.band) return bandDisposition(input, input.band, connected);

    // C3 before C4, matching computeBand's own precedence (relevant_dealer is
    // tested before the hard disqualifiers). A dealer outside our market is
    // better described as other business than as "Not Interested" — and keeping
    // the order identical means the disposition and the band can never disagree
    // about WHY a call was disqualified.
    if (input.relevantDealer === false) {
        return connected("Some other Business", "Lost", "c:irrelevant");
    }

    if (
        input.disqualifier === "not_interested" ||
        input.disqualifier === "dont_call" ||
        input.disqualifier === "hostile"
    ) {
        return connected("Not Interested", "Lost", "c:disqualified");
    }

    const info = input.infoSignalsCount ?? 0;

    // C5 — agreed to a callback and disclosed nothing else. Requiring zero
    // signals is a refinement, not a slip: a dealer who shared his battery spec
    // AND agreed to a callback is described far better by "Information
    // Collected", and nothing is lost, because the callback fact is not carried
    // by the disposition at all — the callback filter reads
    // ai_call_logs.signals->>'callback_agreed' directly.
    if (input.callbackAgreed === true && info === 0) {
        return connected("Ask to Call Back", "Cold", "c:callback_only");
    }

    // C6 — the dealer told us something. Only rows with NO band reach this
    // rule (calls scored before the band engine). A banded call is decided by
    // bandDisposition, where Qualified reads Hot / "AI Qualified" (3 Nov 2026,
    // user decision — the old rule capped every AI call at Warm).
    if (info >= 1) {
        return connected("Information Collected", "Warm", "c:substance");
    }

    // C7 — heard little and disclosed nothing: a hang-up in all but name.
    if (input.pitchHeard === false) {
        return connected("Hung up during intro", "Cold", "c:short_hangup");
    }

    // C8 — sat through the pitch, disclosed nothing, refused nothing. "Need Some
    // Time" and "No requirement in current" would both put a statement in the
    // dealer's mouth; "Pitch Heard, No Response" (added 3 Nov 2026) says only
    // what happened.
    return connected("Pitch Heard, No Response", "Cold", "c:no_disclosure");
}

type ConnectedFn = (
    disposition: string | null,
    bucket: DispositionBucket | null,
    reasonCode: AiDispositionReason,
) => AiCallDisposition;

/** The scored path: L2 = the band, L3 = the closest sheet label for it. */
function bandDisposition(
    input: AiCallDispositionInput,
    band: Band,
    connected: ConnectedFn,
): AiCallDisposition {
    const info = input.infoSignalsCount ?? 0;
    // A firm no beats anything said before it (computeBand's own order).
    if (
        input.disqualifier === "not_interested" ||
        input.disqualifier === "dont_call" ||
        input.disqualifier === "hostile"
    ) {
        return connected("Not Interested", "Lost", "c:disqualified");
    }
    // Outside our product lines (D10).
    if (band === "Disqualified") return connected("Some other Business", "Lost", "c:irrelevant");
    // D8 — a complaint about a battery he already has: a service matter.
    if (input.callbackTopic === "complaint") return connected("Service Issue", "Cold", "c:complaint");
    if (band === "Qualified") return connected("AI Qualified", "Hot", "c:qualified");
    if (band === "Warm") {
        if (info === 0 && input.callbackAgreed === true) {
            return connected("Callback Agreed", "Warm", "c:warm_callback");
        }
        return connected("Information Collected", "Warm", "c:substance");
    }
    // Cold.
    if (input.callbackAgreed === true && info === 0) {
        return connected("Ask to Call Back", "Cold", "c:callback_only");
    }
    if (info >= 1) return connected("Details Shared, Not Qualified", "Cold", "c:cold_details");
    if (input.pitchHeard === false) return connected("Hung up during intro", "Cold", "c:short_hangup");
    return connected("Pitch Heard, No Response", "Cold", "c:no_disclosure");
}

/** Resolve the touchpoint call_status through the shared sheet-derived table. */
function callStatusFor(label: string, connectStatus: ConnectStatus): CallStatus {
    const classified = classifyDisposition(label, {
        callConnected: connectStatus === "connected",
    });
    return callStatusForDisposition(classified) ?? "not_responding";
}

/**
 * The value for lead_touchpoints.external_tag.
 *
 * Carries the fact the L2 bucket cannot: an AI qualification call maxes out at
 * Warm (see C6), so without this a Qualified call and a merely-Warm one would be
 * indistinguishable on the touchpoint.
 */
export function aiExternalTag(input: AiCallDispositionInput): string | null {
    if (input.analysisFailed) return "needs_review";
    return input.band ?? input.bandCallStatus ?? null;
}
