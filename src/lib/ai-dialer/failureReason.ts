// Why a campaign call did not produce a conversation — in words a sales team
// can act on.
//
// The campaign table used to show "Failed" and "Trigger failed ⓘ" for every
// unsuccessful row, with the real reason hidden in a hover tooltip. Measured on
// sandbox, that one chip was covering at least six genuinely different things:
//
//   trigger_failed: Calling from_number doesn't exist for vobiz…   100 rows
//   trigger_failed  (bare, no detail captured)                     105 rows
//   trigger_failed: INVITE failed: sip status: 486: Busy Here        19 rows
//   trigger_failed: Invalid API key                                  13 rows
//   trigger_failed: … 480: Temporarily Unavailable                    7 rows
//   trigger_failed: sip request timed out                             1 row
//
// The single most useful distinction is not in the "why didn't the dealer
// answer" family at all: the LARGEST bucket is our own misconfiguration. 100
// leads were consumed by a from_number that did not exist and 13 by a bad API
// key. Nothing was wrong with those dealers, and filing them under the same
// "Failed" as a busy line is why a broken provider config can burn a hundred
// leads without anyone noticing. CONFIG_ERROR is therefore its own reason.
//
// ── EVIDENCE ORDER ─────────────────────────────────────────────────────────
// A TRANSCRIPT BEATS THE OUTCOME STRING. If the provider gave us a transcript
// the call happened, whatever dialer_campaign_leads.call_outcome says — which is
// how a row that plainly connected could still read "Trigger failed". That also
// keeps this module consistent with the AI-connected hard block, which already
// treats transcript presence as proof of contact.
//
// This is a DISPLAY vocabulary, deliberately separate from the CC sheet's
// L1/L2/L3 in aiDisposition.ts. The sheet answers "what is the sales state of
// this lead"; this answers "what happened to this call, and can I try again".
// They are derived from the same evidence and must not contradict each other —
// see the shared-evidence test.

export const FAILURE_REASON_CODES = [
    "not_answered",
    "busy",
    "voicemail",
    "disconnected",
    "silent_call",
    "no_response",
    "technical",
    "config_error",
    "stopped",
    "ineligible",
    "unknown",
] as const;

export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number];

export type FailureReason = {
    code: FailureReasonCode;
    /** Short label for the chip. */
    label: string;
    /** One line of "so what" for the tooltip. */
    hint: string;
    /** The raw provider text, when there is any. Never invented. */
    detail: string | null;
    /**
     * Is dialling this lead again worth doing?
     *
     * FALSE for the two CONNECTED outcomes — the dealer was reached, so the
     * AI-connected hard block will refuse them anyway and the honest next step
     * is a human. Also false for rows that were never eligible.
     */
    retryable: boolean;
    /**
     * TRUE when the failure was OURS, not the dealer's. These rows tell you
     * nothing about the lead and everything about the dialer configuration.
     */
    ourFault: boolean;
};

type Spec = Omit<FailureReason, "detail">;

const SPECS: Record<FailureReasonCode, Spec> = {
    not_answered: {
        code: "not_answered",
        label: "Not answered",
        hint: "The dealer did not pick up. Worth trying again at a different time.",
        retryable: true,
        ourFault: false,
    },
    busy: {
        code: "busy",
        label: "Busy line",
        hint: "The dealer's number was engaged. Worth trying again shortly.",
        retryable: true,
        ourFault: false,
    },
    voicemail: {
        code: "voicemail",
        label: "Voicemail",
        hint: "The call reached voicemail rather than the dealer.",
        retryable: true,
        ourFault: false,
    },
    disconnected: {
        code: "disconnected",
        label: "Disconnected",
        hint: "The call ended before any conversation started.",
        retryable: true,
        ourFault: false,
    },
    silent_call: {
        code: "silent_call",
        label: "Silent call",
        hint: "The dealer answered but never spoke. They HAVE been reached — the AI will not call again.",
        retryable: false,
        ourFault: false,
    },
    no_response: {
        code: "no_response",
        label: "No response",
        hint: "The dealer answered and heard the pitch but gave nothing back. They HAVE been reached — needs a person.",
        retryable: false,
        ourFault: false,
    },
    technical: {
        code: "technical",
        label: "Network issue",
        hint: "The call failed on the network or at the provider, not with the dealer.",
        retryable: true,
        ourFault: false,
    },
    config_error: {
        code: "config_error",
        label: "Dialer misconfigured",
        hint: "Nothing was wrong with this lead — the dialer itself could not place the call. Fix the provider settings, then retry.",
        retryable: true,
        ourFault: true,
    },
    stopped: {
        code: "stopped",
        label: "Stopped",
        hint: "The campaign was stopped before this lead was dialled.",
        retryable: true,
        ourFault: false,
    },
    ineligible: {
        code: "ineligible",
        label: "Skipped",
        hint: "This lead was not eligible when its turn came — already with sales, already reached by AI, or no phone.",
        retryable: false,
        ourFault: false,
    },
    unknown: {
        code: "unknown",
        label: "Failed",
        hint: "No reason was captured for this failure.",
        retryable: true,
        ourFault: false,
    },
};

export type FailureReasonInput = {
    /** dialer_campaign_leads.status */
    status: string | null;
    /** dialer_campaign_leads.call_outcome */
    callOutcome: string | null;
    /** ai_call_logs.transcript IS NOT NULL, for THIS attempt. */
    hasTranscript?: boolean | null;
    /** ai_call_logs.status — the raw provider status. */
    providerStatus?: string | null;
    /** ai_call_logs.call_status — complete | dropped_partial | dropped_empty. */
    bandCallStatus?: string | null;
};

/** Everything after "trigger_failed:" / "trigger_exception:", or null. */
function triggerDetail(outcome: string): string | null {
    const m = outcome.match(/^trigger_(?:failed|exception):?\s*(.*)$/i);
    if (!m) return null;
    const rest = (m[1] ?? "").trim();
    return rest || null;
}

/**
 * Classify a provider's free-text trigger error.
 *
 * These strings come straight from Bolna / ElevenLabs and are not a vocabulary
 * we control, so this matches on substrings and falls back to `unknown` rather
 * than guessing. Every pattern here was taken from a real row.
 */
function classifyTriggerDetail(detail: string): FailureReasonCode {
    const d = detail.toLowerCase();

    // OURS, not the dealer's. Checked first: a misconfigured from_number also
    // produces SIP noise, and reporting that as "busy" would blame the lead.
    if (
        d.includes("from_number") ||
        d.includes("api key") ||
        d.includes("not found") ||
        d.includes("unauthorized") ||
        d.includes("forbidden") ||
        d.includes("agent") ||
        d.includes("telephony provider")
    ) {
        return "config_error";
    }

    // SIP 486 Busy Here.
    if (d.includes("486") || d.includes("busy")) return "busy";
    // SIP 480 Temporarily Unavailable / 503 Service Unavailable.
    if (d.includes("480") || d.includes("temporarily unavailable")) return "not_answered";
    if (d.includes("voicemail") || d.includes("machine")) return "voicemail";
    if (d.includes("408") || d.includes("timed out") || d.includes("timeout")) {
        return "technical";
    }
    if (
        d.includes("network") ||
        d.includes("sip") ||
        d.includes("503") ||
        d.includes("500") ||
        d.includes("connection")
    ) {
        return "technical";
    }
    if (d.includes("no answer") || d.includes("noanswer")) return "not_answered";
    if (d.includes("rejected") || d.includes("declined") || d.includes("disconnect")) {
        return "disconnected";
    }
    return "unknown";
}

/** Provider status strings, normalised the same way aiDisposition does. */
function classifyProviderStatus(raw: string): FailureReasonCode {
    const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (["no_answer", "noanswer", "not_answered"].includes(s)) return "not_answered";
    if (["voicemail", "machine_detected", "answering_machine"].includes(s)) {
        return "voicemail";
    }
    if (["busy", "user_busy"].includes(s)) return "busy";
    if (["call_disconnected", "rejected", "declined", "canceled", "cancelled"].includes(s)) {
        return "disconnected";
    }
    if (["failed", "error", "initiation_failure"].includes(s)) return "technical";
    return "unknown";
}

/**
 * The reason a campaign row did not produce a conversation.
 *
 * Returns null for rows that SUCCEEDED — there is no failure to explain, and the
 * caller should keep rendering the analyzer outcome it already shows.
 */
export function deriveFailureReason(
    input: FailureReasonInput,
): FailureReason | null {
    const outcome = (input.callOutcome ?? "").trim();
    const lower = outcome.toLowerCase();

    // ── Connected outcomes ────────────────────────────────────────────────
    // A transcript is proof the call happened, and it OUTRANKS the outcome
    // string — which is exactly how a row that plainly connected could still
    // read "Trigger failed".
    if (input.hasTranscript) {
        if (input.bandCallStatus === "dropped_empty" || lower === "dropped_empty") {
            return { ...SPECS.silent_call, detail: null };
        }
        // Answered, heard something, gave nothing usable back. Distinct from a
        // silent call: there WAS speech, it just carried no signal.
        if (lower === "unknown" || lower === "needs_review" || lower === "no_response") {
            return { ...SPECS.no_response, detail: null };
        }
        // Anything else with a transcript is a real conversation — the analyzer
        // outcome describes it, and that is not this function's job.
        //
        // UNLESS the row is still marked failed. That combination is
        // contradictory (a transcript means the call happened) and it is
        // precisely the case that produced a bare "Failed" chip with a playable
        // recording behind it. The call connected, so it is not retryable, and
        // the honest label is that we got nothing usable back.
        return input.status === "failed"
            ? { ...SPECS.no_response, detail: outcome || null }
            : null;
    }

    if (input.status !== "failed") {
        // completed / pending / calling with no transcript yet. Only a
        // 'completed' row with no transcript is a failure worth naming, and the
        // no-transcript finalize path marks those failed — so nothing to say.
        return null;
    }

    // ── Explicit outcomes written by our own pipeline ─────────────────────
    if (lower === "stopped_by_user") return { ...SPECS.stopped, detail: null };
    if (lower.startsWith("ineligible") || lower === "no_phone") {
        return { ...SPECS.ineligible, detail: outcome };
    }
    if (lower === "no_webhook") {
        return {
            ...SPECS.technical,
            hint: "The provider never told us how the call ended.",
            detail: outcome,
        };
    }

    // ── Trigger failures — the big bucket, and the informative one ────────
    const detail = triggerDetail(outcome);
    if (detail !== null || /^trigger_(failed|exception)/i.test(lower)) {
        const code = detail ? classifyTriggerDetail(detail) : "unknown";
        return { ...SPECS[code], detail };
    }

    // ── A raw provider status stored as the outcome ───────────────────────
    if (outcome) {
        const code = classifyProviderStatus(outcome);
        if (code !== "unknown") return { ...SPECS[code], detail: null };
    }

    // Nothing was captured. Fall back to the raw provider status if the log has
    // one, and only then to a bare "Failed".
    if (input.providerStatus) {
        const code = classifyProviderStatus(input.providerStatus);
        if (code !== "unknown") {
            return { ...SPECS[code], detail: input.providerStatus };
        }
    }

    return { ...SPECS.unknown, detail: outcome || null };
}

/**
 * Is this row worth re-queueing?
 *
 * Used by the Retry-failed flows. A row with no failure reason (i.e. it
 * succeeded) is not retryable either — there is nothing to retry.
 */
export function isRetryableFailure(input: FailureReasonInput): boolean {
    return deriveFailureReason(input)?.retryable ?? false;
}
