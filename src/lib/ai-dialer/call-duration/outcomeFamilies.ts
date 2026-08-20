/**
 * WHY a call in a given duration bucket ended, collapsed to the handful of
 * answers a human actually asks for.
 *
 * ../failureReason.ts carries eleven codes because the retry logic needs that
 * much resolution — "busy line" and "dialer misconfigured" lead to completely
 * different actions. A histogram bar is a different job: stacked into a 140px
 * bar, eleven segments is noise. These five are the families the team argues
 * about when a campaign underperforms:
 *
 *   conversation   the AI and the dealer actually talked
 *   no_response    dealer answered, heard the pitch, gave nothing back
 *   silent         dealer answered and never spoke at all
 *   dropped        the call fell over — busy, no answer, network, misconfig
 *   unclassified   nothing was captured
 *
 * The full eleven-code detail is NOT thrown away: the endpoint returns per-code
 * slices per bucket, so the legend can name "Dialer misconfigured" exactly while
 * the bar itself stays readable. This module only decides the colour grouping.
 *
 * SILENT AND NO-RESPONSE ARE NOT FAILURES TO DIAL. Both mean the dealer was
 * REACHED (failureReason marks them retryable: false for that reason). In a
 * sub-20-second bucket they are the interesting cases — a dealer who picked up
 * and hung up is a script problem, not a telephony problem — which is why they
 * get their own families instead of being folded into "dropped".
 *
 * PURE — no database import. Imported by both the server-side fold and the
 * client-side legend, so the colour of a segment and the meaning of a segment
 * cannot drift apart.
 */
import type { FailureReasonCode } from "../failureReason";

export const OUTCOME_FAMILIES = [
    {
        key: "conversation",
        label: "Real conversation",
        hint: "The AI and the dealer actually talked.",
        color: "#0d9488",
        swatch: "bg-teal-600",
    },
    {
        key: "no_response",
        label: "No response",
        hint: "The dealer answered and heard the pitch but gave nothing back.",
        color: "#f59e0b",
        swatch: "bg-amber-500",
    },
    {
        key: "silent",
        label: "Silent call",
        hint: "The dealer answered but never spoke.",
        color: "#6366f1",
        swatch: "bg-indigo-500",
    },
    {
        key: "dropped",
        label: "Dropped / cut off",
        hint: "The call fell over before a conversation could happen.",
        color: "#f43f5e",
        swatch: "bg-rose-500",
    },
    {
        key: "unclassified",
        label: "Unclassified",
        hint: "No reason was captured for how this call ended.",
        color: "#94a3b8",
        swatch: "bg-slate-400",
    },
] as const;

export type OutcomeFamily = (typeof OUTCOME_FAMILIES)[number]["key"];

export const OUTCOME_FAMILY_KEYS = OUTCOME_FAMILIES.map((f) => f.key) as OutcomeFamily[];

export const OUTCOME_FAMILIES_BY_KEY = Object.fromEntries(
    OUTCOME_FAMILIES.map((f) => [f.key, f]),
) as Record<OutcomeFamily, (typeof OUTCOME_FAMILIES)[number]>;

/**
 * Which family does a failure code belong to?
 *
 * `null` means deriveFailureReason found nothing to explain — the call
 * succeeded — which is precisely the "conversation" family.
 *
 * config_error sits under "dropped" rather than getting its own colour: on a
 * connected call it is vanishingly rare (a misconfigured dialer usually cannot
 * place the call at all, so those rows never reach this histogram), and the
 * per-code slice still names it in the legend when it does occur.
 */
export function classifyOutcomeFamily(code: FailureReasonCode | null | undefined): OutcomeFamily {
    if (code == null) return "conversation";

    switch (code) {
        case "no_response":
            return "no_response";
        case "silent_call":
            return "silent";
        case "disconnected":
        case "technical":
        case "not_answered":
        case "busy":
        case "voicemail":
        case "config_error":
            return "dropped";
        case "stopped":
        case "ineligible":
        case "unknown":
        default:
            return "unclassified";
    }
}
