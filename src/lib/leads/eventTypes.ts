// The event types of the Lead events download (tracker IDs 34 and 35).
// CLIENT-SAFE: no database import — the catalogue sends these as the options
// of the "Event type" filter, and eventLog.ts uses the same list to skip the
// sources nobody asked for.
//
// `label` is EXACTLY the text the SQL writes into the event_type column
// (src/lib/leads/eventLog.ts). `prefix` marks a family whose label carries a
// suffix ("Commercials: brochure sent").
//
// TO ADD AN EVENT TYPE (e.g. ID 86 "Limit passed", "Onboarding stalled"):
// add a row here, then a branch in eventLog.ts's BRANCHES tagged with the
// same `value`. The filter, the dropdown and the column help pick it up.

export type LeadEventType = {
    value: string;
    label: string;
    /** Matches every event_type starting with this text instead of `label` exactly. */
    prefix?: string;
};

export const LEAD_EVENT_TYPES = [
    { value: "lead_created", label: "Lead created" },
    { value: "re_inquiry", label: "Re-inquiry" },
    { value: "sales_ready", label: "Sales-ready" },
    { value: "status_change", label: "Status change" },
    { value: "owner_change", label: "Owner change" },
    { value: "interest_change", label: "Interest change" },
    { value: "contactability", label: "Contactability change" },
    { value: "call", label: "Call" },
    { value: "call_ai", label: "Call (AI)" },
    { value: "visit", label: "Visit" },
    { value: "quote_requested", label: "Quote requested" },
    { value: "quote_approved", label: "Quote approved" },
    { value: "quote_rejected", label: "Quote rejected" },
    { value: "quote_sent", label: "Quote sent" },
    { value: "quote_send_failed", label: "Quote send failed" },
    { value: "quote_dealer_decision", label: "Quote dealer decision" },
    { value: "commercials", label: "Commercials (brochure, terms)", prefix: "Commercials: " },
    { value: "escalation_raised", label: "Escalation raised" },
    { value: "escalation_ceo_comment", label: "Escalation CEO comment" },
    { value: "escalation_resolved", label: "Escalation resolved" },
    { value: "log_detail_change", label: "Log detail change" },
] as const satisfies readonly LeadEventType[];

export type LeadEventTypeValue = (typeof LEAD_EVENT_TYPES)[number]["value"];

const BY_VALUE = new Map<string, LeadEventType>(LEAD_EVENT_TYPES.map((t) => [t.value, t]));

/**
 * The `event_type` request param ("call,visit") → the chosen values, known
 * ones only, in catalogue order. Nothing chosen, nothing recognised, or every
 * type chosen → undefined, meaning "all events" (no filter at all).
 */
export function parseEventTypes(raw: string | null | undefined): LeadEventTypeValue[] | undefined {
    const wanted = new Set(
        (raw ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );
    const picked = LEAD_EVENT_TYPES.filter((t) => wanted.has(t.value)).map((t) => t.value);
    if (picked.length === 0 || picked.length === LEAD_EVENT_TYPES.length) return undefined;
    return picked;
}

/** The chosen values → what the SQL must match: exact labels and label prefixes. */
export function eventTypeMatchers(values: readonly string[]): { exact: string[]; prefixes: string[] } {
    const exact: string[] = [];
    const prefixes: string[] = [];
    for (const v of values) {
        const t = BY_VALUE.get(v);
        if (!t) continue;
        if (t.prefix) prefixes.push(t.prefix);
        else exact.push(t.label);
    }
    return { exact, prefixes };
}

/** "call,visit" → "Call, Visit" — for the file's "filters used" line. */
export function eventTypeLabels(values: readonly string[]): string {
    return values.map((v) => BY_VALUE.get(v)?.label ?? v).join(", ");
}
