// The ONLY place NeoDove field names meet iTarang field names (E-224).
//
// This containment is the whole design. NeoDove's inbound payload shape is
// undocumented — no developer reference, no OpenAPI, no samples anywhere
// public — so the parsing below is an educated guess that WILL be wrong in
// detail. Keeping every guess in one file means correcting it against a real
// captured payload is a single-function edit, and no route, handler or test
// call site moves.
//
// Two rules follow from "NeoDove has no read API":
//   1. Never reject an inbound event for being unrecognised. A refused delivery
//      cannot be re-fetched — it is gone. Parse what we can, keep `raw`, and
//      let the caller flag it.
//   2. Never guess a disposition. An unmapped value returns null and is logged,
//      because silently mapping an unknown NeoDove stage onto a CRM status
//      would corrupt the funnel in a way nobody would notice for weeks.

import { createHash } from "node:crypto";
// From dedupe-rules, not dedupe: this module must stay free of the DB client
// so it can be unit-tested. Same implementation either way — dedupe.ts
// re-exports it.
import { normalizePhone } from "@/lib/leads/dedupe-rules";
import {
    callStatusForDisposition,
    classifyDisposition,
    type ClassifiedDisposition,
} from "@/lib/leads/dispositions";
import type { CallStatus, TouchpointType } from "@/lib/lifecycle/touchpointTypes";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import type {
    NeodoveEventType,
    NeodoveInboundEvent,
    NeodovePushLead,
} from "./types";

// ── Outbound: dealer_lead → NeoDove Custom Integration payload ─────────────

export type PushableLead = {
    id: string;
    phone: string | null;
    dealer_name: string | null;
    shop_name: string | null;
    city: string | null;
    state: string | null;
    area: string | null;
    pincode: string | null;
    language: string | null;
    source: string | null;
    lead_status: string | null;
    interest_level: string | null;
};

/**
 * Build the POST body for a campaign's Custom Integration endpoint.
 *
 * `name`, `mobile` and `email` are RESERVED key names in NeoDove — they map to
 * first-class lead fields. Everything else becomes an untyped custom field, so
 * our columns go out under an `itarang_` prefix: it prevents collisions with
 * whatever custom fields the account already has, and it makes the CRM's data
 * self-evident to an agent looking at the lead in NeoDove's UI.
 *
 * `itarang_lead_id` is the important one — it is what lets an inbound webhook
 * be joined back to the exact row we pushed, IF NeoDove echoes custom fields
 * back. It may not; hence the phone fallback in resolveInboundLead().
 *
 * Returns null when the lead has no usable mobile: `mobile` is NeoDove's only
 * mandatory field, so such a push would be rejected anyway.
 */
export function dealerLeadToNeodove(lead: PushableLead): NeodovePushLead | null {
    const mobile = lead.phone ? normalizePhone(lead.phone) : null;
    if (!mobile) return null;

    const payload: NeodovePushLead = {
        // NeoDove's own examples use the bare national number. Sent without the
        // +91 prefix for that reason; VERIFY against a real push (Phase 0) —
        // if their matcher is prefix-sensitive this is the line to change.
        mobile: mobile.replace(/^\+91/, ""),
    };

    const name = lead.dealer_name || lead.shop_name;
    if (name) payload.name = name;

    // Custom fields. Undefined values are dropped rather than sent as empty
    // strings, so NeoDove doesn't create a wall of blank custom fields.
    const custom: Record<string, string | null | undefined> = {
        itarang_lead_id: lead.id,
        itarang_shop_name: lead.shop_name,
        itarang_city: lead.city,
        itarang_state: lead.state,
        itarang_area: lead.area,
        itarang_pincode: lead.pincode,
        itarang_language: lead.language,
        itarang_source: lead.source,
        itarang_status: lead.lead_status,
        itarang_interest: lead.interest_level,
    };
    for (const [k, v] of Object.entries(custom)) {
        if (v !== null && v !== undefined && String(v).trim() !== "") {
            payload[k] = String(v);
        }
    }

    return payload;
}

// ── Inbound: raw NeoDove JSON → NeodoveInboundEvent ───────────────────────

// NeoDove's payload key casing is unknown, and their UI mixes snake_case and
// camelCase. Rather than betting on one, each field is looked up across every
// plausible spelling. Cheap, and it means a casing surprise in the real payload
// costs nothing.
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
        // Case-insensitive second pass.
        const hit = Object.keys(obj).find((o) => o.toLowerCase() === k.toLowerCase());
        if (hit && obj[hit] !== undefined && obj[hit] !== null && obj[hit] !== "") {
            return obj[hit];
        }
    }
    return undefined;
}

const asString = (v: unknown): string | null =>
    v === undefined || v === null || v === "" ? null : String(v).trim();

const asNumber = (v: unknown): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

// http(s) only. A recording URL is rendered as a link and as an <audio> src, so
// anything else — a relative path, a `javascript:` string, a plain "NA" — is
// treated as absent rather than passed through to the browser.
const asUrl = (v: unknown): string | null => {
    const s = asString(v);
    if (!s) return null;
    try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:" ? s : null;
    } catch {
        return null;
    }
};

// Accepts an ISO string OR an epoch, in seconds or milliseconds, as a number or
// a numeric string. NeoDove sends `"time":"1638806214940"` — epoch millis as a
// STRING — and `new Date("1638806214940")` is an Invalid Date, so before this
// every inbound event parsed with occurredAt = null. That is not cosmetic: with
// no timestamp, synthesizeEventId falls back to a 60-second bucket, so two
// genuine calls to the same lead inside a minute collapse to one event id and
// the second is silently dropped as a replay.
const asDate = (v: unknown): Date | null => {
    const s = asString(v);
    if (!s) return null;
    if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000); // epoch seconds
    if (/^\d{13}$/.test(s)) return new Date(Number(s)); // epoch millis
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
};

// "true"/"false"/true/1/"yes" → boolean; anything unrecognised → null rather
// than false, because "we were not told" and "the call did not connect" lead to
// different call statuses.
const asBool = (v: unknown): boolean | null => {
    if (typeof v === "boolean") return v;
    const s = asString(v)?.toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
    return null;
};

/**
 * Derive the event type from whatever NeoDove sent.
 *
 * Falls back to `lead_disposed` rather than throwing: an event carrying a
 * disposition we can't classify is still worth recording as a touchpoint, and
 * the `raw` payload is preserved for re-parsing.
 */
function inferEventType(body: Record<string, unknown>): NeodoveEventType {
    // `event_name` is the REAL key — confirmed 2026-08-03 from NeoDove's own
    // sample curl, which sends `"event_name":"LEAD_DISPOSE"`. It was absent from
    // this list, so every inbound event fell through to the `lead_disposed`
    // default. The consequence was not a missing label: a LEAD_CREATE was
    // classified as a disposition, so a lead born in NeoDove went to
    // handleLeadDisposed, failed to match any phone here and landed as
    // `unresolved` instead of being created. The inbound-create half of the
    // two-way sync could never have worked.
    const raw = (
        asString(
            pick(body, "event_name", "eventName", "event", "event_type", "eventType", "trigger"),
        ) ?? ""
    )
        .toLowerCase()
        .replace(/[\s-]+/g, "_");

    if (raw.includes("delete")) return "lead_deleted";
    if (raw.includes("create")) return "lead_created";
    if (raw.includes("not_connected") || raw.includes("notconnected")) {
        return "call_not_connected";
    }
    if (raw.includes("connected")) return "call_connected";
    if (raw.includes("dispose") || raw.includes("disposition")) return "lead_disposed";
    return "lead_disposed";
}

/**
 * Stable synthetic idempotency key, for when NeoDove sends no usable event id.
 *
 * Without this, a webhook with no id would be re-processed on every retry and
 * pile up duplicate touchpoints. Hashing (campaign, mobile, event, timestamp)
 * gives the same key for a genuine retry of the same event and a different one
 * for a real second call — as long as NeoDove sends a timestamp. If it doesn't,
 * the minute-bucketed `now` keeps retries inside a 60s window deduped, which is
 * the best available without an id and is why capturing the real payload in
 * Phase 0 matters.
 */
function synthesizeEventId(parts: {
    campaignName: string | null;
    mobile: string | null;
    eventType: string;
    occurredAt: Date | null;
}): string {
    const stamp = parts.occurredAt
        ? parts.occurredAt.toISOString()
        : `minute:${Math.floor(Date.now() / 60000)}`;
    const material = [
        parts.campaignName ?? "",
        parts.mobile ?? "",
        parts.eventType,
        stamp,
    ].join("|");
    return `syn_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/**
 * Pull NeoDove's `other_properties` name/value pairs up into flat keys.
 *
 * Spread UNDER the real body by the caller, never over it: if NeoDove ever ships
 * a top-level key that collides with one of our custom-field names, theirs must
 * win — a custom field is our data round-tripping, a top-level field is theirs.
 */
function flattenOtherProperties(
    body: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const lists = body.other_properties ?? body.otherProperties;
    if (!Array.isArray(lists)) return out;
    for (const list of lists) {
        const props = (list as { properties?: unknown } | null)?.properties;
        if (!Array.isArray(props)) continue;
        for (const p of props) {
            const entry = p as { name?: unknown; value?: unknown } | null;
            const name = asString(entry?.name);
            if (name) out[name] = entry?.value;
        }
    }
    return out;
}

export function parseInboundEvent(raw: unknown): NeodoveInboundEvent {
    const body: Record<string, unknown> =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

    // Some webhook providers nest the useful part one level down. Merge a
    // single level of `data`/`lead`/`payload` so either shape parses.
    const nested = pick(body, "data", "lead", "payload");
    const base: Record<string, unknown> =
        nested && typeof nested === "object"
            ? { ...body, ...(nested as Record<string, unknown>) }
            : body;

    // Our own custom fields come back under `other_properties`, as an array of
    // contact lists each holding an array of {name, value} pairs — NOT as flat
    // keys. Confirmed from the first live webhook, 2026-08-03:
    //
    //   "other_properties": [{ "contact_list_name": "CUSTOM_INTEGRATION",
    //                          "properties": [{ "name": "itarang_lead_id",
    //                                           "value": "L-7VOPwrpR" }, … ] }]
    //
    // This is the whole point of sending `itarang_lead_id` on the push: it is
    // the join key that survives a phone number being edited in NeoDove. It was
    // being ignored entirely, so inbound matching fell back to phone alone —
    // exactly the fragility the field exists to avoid.
    const flat: Record<string, unknown> = { ...flattenOtherProperties(base), ...base };

    const eventType = inferEventType(flat);
    const rawMobile = asString(
        pick(flat, "mobile", "phone", "mobile_number", "mobileNumber", "contact_number"),
    );
    // `time` first: it is what NeoDove actually sends (epoch millis as a string).
    const occurredAt = asDate(
        pick(flat, "time", "timestamp", "created_at", "createdAt", "event_time", "call_time"),
    );
    const campaignName = asString(
        pick(flat, "campaign", "campaign_name", "campaignName"),
    );
    const campaignId = asString(pick(flat, "campaign_id", "campaignId"));

    // NeoDove sends NO event id — confirmed against their sample payload, which
    // carries lead_id, campaign_id and time but nothing per-delivery. So the
    // synthetic key is the normal path here, not the fallback, and it is fed the
    // campaign UUID (which is always present) rather than the campaign name
    // (which never is).
    const externalEventId =
        asString(pick(flat, "event_id", "eventId", "unique_id", "uuid")) ??
        synthesizeEventId({
            campaignName: campaignId ?? campaignName,
            mobile: rawMobile,
            eventType,
            occurredAt,
        });

    return {
        eventType,
        externalEventId,
        mobile: rawMobile ? normalizePhone(rawMobile) : null,
        neodoveLeadId: asString(pick(flat, "lead_id", "leadId", "neodove_lead_id")),
        // Flattened out of other_properties above. Same key we send in
        // dealerLeadToNeodove().
        itarangLeadId: asString(pick(flat, "itarang_lead_id", "itarangLeadId")),
        campaignName,
        campaignId,
        callConnected: asBool(pick(flat, "call_connected", "callConnected")),
        // READABLE LABELS ONLY. `lead_status_name` first — it is the human one
        // ("Open"/"Interested") and the live payload carries it.
        //
        // `lead_status` is DELIBERATELY NOT in this list. It is the same fact as
        // an opaque numeric code (6) with no published lookup table, and having
        // it here as a last resort is precisely what put "Disposition: 6" on
        // screen: `disposition` is what the UI renders, so any unreadable value
        // reachable through it will eventually be shown to a sales head as
        // though it were a disposition. The code lives in `dispositionCode`,
        // where rendering it requires saying it is a code.
        disposition: asString(
            pick(
                flat,
                "lead_status_name",
                "leadStatusName",
                "disposition",
                "call_disposition",
                "callDisposition",
                "status",
            ),
        ),
        // NeoDove's numeric code, kept separately so it is never mistaken for a
        // label but is still available for diagnosis and for building the code
        // table once they supply it.
        dispositionCode: asString(pick(flat, "lead_status", "leadStatus")),
        tag: asString(pick(flat, "lead_tag_name", "leadTagName", "tag")),
        // `lead_stage_name` is the real key ("Open" in their sample); the three
        // we guessed at are absent from the payload.
        stage: asString(
            pick(flat, "lead_stage_name", "leadStageName", "stage", "lead_stage", "leadStage"),
        ),
        agentName: asString(pick(flat, "agent", "agent_name", "agentName", "user")),
        callDurationSec: asNumber(
            pick(flat, "duration", "call_duration", "callDuration", "duration_sec"),
        ),
        // E-226. Only accepted if it looks like an http(s) URL: this value is
        // rendered as a link and fed to an <audio> element, so a stray "yes" or
        // a bare file name in whichever field NeoDove reuses would become a
        // broken player rather than an obviously absent one.
        recordingUrl: asUrl(
            pick(
                flat,
                "recording_url",
                "recordingUrl",
                "recording",
                "call_recording",
                "callRecording",
                "recording_link",
                "audio_url",
                "audioUrl",
            ),
        ),
        // `dispose_remarks` is what the telecaller actually typed — the "disposed
        // reason". First in the list because it is the only one of these NeoDove
        // really sends.
        remarks: asString(
            pick(flat, "dispose_remarks", "disposeRemarks", "remarks", "notes", "comment", "description"),
        ),
        occurredAt,
        name: asString(pick(flat, "name", "lead_name", "customer_name")),
        email: asString(pick(flat, "email", "email_id")),
        city: asString(pick(flat, "city", "location")),
        raw,
    };
}

// ── NeoDove vocabulary → iTarang vocabulary ───────────────────────────────

/**
 * NeoDove event → lead_touchpoints.touchpoint_type.
 *
 * All call-ish events become `inside_sales_call`, which is accurate: a NeoDove
 * campaign is a human agent dialling, not our AI dialer. Mapping them to
 * `ai_call` would corrupt the BRD §0.11 AI-vs-human reporting split.
 */
export function touchpointTypeFor(eventType: NeodoveEventType): TouchpointType {
    switch (eventType) {
        case "call_connected":
        case "call_not_connected":
        case "lead_disposed":
            return "inside_sales_call";
        case "lead_created":
        case "lead_deleted":
            return "status_change_note";
    }
}

/**
 * The disposition this event carries, classified against the CC team's sheet.
 *
 * WHY `tag` IS READ FIRST. The live account puts the sheet's L3 values in
 * `lead_tag_name` — that is what NeoDove's own "Leads by tags" chart renders
 * (Loan Procedure Issue, Price High, REJECTED BY US, Onboarding Done) — while
 * `lead_status_name`, which this module calls `disposition`, carried generic
 * values like "Open" in the captured payload. Reading `disposition` first would
 * therefore classify almost every real call as unmapped.
 *
 * `remarks` (`dispose_remarks`) is tried last and ONLY for an exact match: some
 * accounts have the agent type the disposition rather than pick it. It is never
 * the unknown-value fallback, because that field is prose and storing a whole
 * sentence as a disposition label would poison the filter dropdown.
 *
 * ONLY `tag` MAY SUPPLY AN UNMAPPED VALUE. When nothing matches the sheet, the
 * fallback reads `tag` alone — never `disposition`. `disposition` is
 * `lead_status_name`, and NeoDove's status vocabulary is Open / Follow-Up /
 * Closed: real values, but statuses, not dispositions. Measured against 2,178
 * stored webhooks, allowing them through produced 31 leads whose "disposition"
 * was "Open", "Follow-Up", "Closed" or the bare code "6" — each of which would
 * then appear in the filter dropdown as though a telecaller had chosen it. They
 * are still classified when they happen to match the sheet; they just cannot
 * invent a disposition of their own.
 *
 * Returns null only when the event named no usable disposition at all.
 */
export function dispositionFor(
    event: NeodoveInboundEvent,
): ClassifiedDisposition | null {
    const hints = { stage: event.stage, callConnected: event.callConnected };
    for (const raw of [event.tag, event.disposition, event.remarks]) {
        const hit = classifyDisposition(raw, hints);
        if (hit?.isKnown) return hit;
    }
    // Nothing matched the sheet. Keep an unmapped TAG rather than discarding it
    // — it is the signal that NeoDove's disposition list has moved, and it is
    // only visible if it is stored.
    return classifyDisposition(event.tag, hints);
}

// The sheet's ten Not Connected reasons → our CallStatus now lives in
// src/lib/leads/dispositions.ts as NOT_CONNECTED_TO_CALL_STATUS, because it is a
// property of the sheet rather than of NeoDove — the AI dialer and the rep's Log
// Touchpoint form need the identical mapping. Imported above.
//
// DISPOSITION_TO_CALL_STATUS below stays here: it IS NeoDove-specific, covering
// their factory vocabulary for values outside the sheet.

// FALLBACK ONLY, for values outside the CC sheet — NeoDove's factory defaults,
// and whatever a second campaign's disposition list turns out to hold. The
// sheet (src/lib/leads/dispositions.ts) is consulted first and settles almost
// everything; this exists so a lead worked in a campaign configured with the
// stock vocabulary still gets a call_status instead of null.
const DISPOSITION_TO_CALL_STATUS: Record<string, CallStatus> = {
    interested: "connected",
    connected: "connected",
    answered: "connected",
    "call back": "connected",
    callback: "connected",
    "follow up": "connected",
    "not interested": "connected",
    busy: "not_responding",
    "no answer": "not_responding",
    "not answered": "not_responding",
    ringing: "not_responding",
    "not reachable": "not_reachable",
    unreachable: "not_reachable",
    "switched off": "not_reachable",
    "out of service": "not_reachable",
    "wrong number": "incorrect_number",
    "invalid number": "incorrect_number",
    "incorrect number": "incorrect_number",
};

export function callStatusFor(event: NeodoveInboundEvent): CallStatus | null {
    const classified = dispositionFor(event);
    const known = classified?.isKnown ? classified : null;

    // A `call_not_connected` event cannot be overturned by a disposition:
    // NeoDove fires it from the dialler, not from a dropdown, so when the two
    // disagree the mechanical fact wins and the tag is treated as stale. The
    // disposition still gets to say WHY, which is the part that was missing —
    // this used to return a flat `not_responding` for every unanswered call.
    if (event.eventType === "call_not_connected") {
        const reason =
            known?.connectStatus === "not_connected"
                ? callStatusForDisposition(known)
                : null;
        return reason ?? "not_responding";
    }

    if (known) {
        const reason = callStatusForDisposition(known);
        if (reason) return reason;
    }

    // Outside the sheet: fall back to the stock-vocabulary map.
    const key = (classified?.label ?? event.disposition ?? "").trim().toLowerCase();
    const mapped = key ? DISPOSITION_TO_CALL_STATUS[key] : undefined;
    if (mapped) return mapped;

    // Otherwise fall back to the boolean, which is all the fixed webhook payload
    // gives us. `false` means the call did not connect but NOT why, and our
    // CallStatus vocabulary has no reason-unknown member — so it lands in
    // `not_responding`, matching what call_not_connected above already does. It
    // is the least-wrong bucket, not a measurement: do not read
    // not_responding-vs-not_reachable ratios off this path.
    if (event.callConnected === true) return "connected";
    if (event.callConnected === false) return "not_responding";

    return event.eventType === "call_connected" ? "connected" : null;
}

// NeoDove stage → our LeadStatus. Intentionally SPARSE and intentionally
// missing every terminal state.
//
// `Lost` is absent on purpose: our Lost transition requires a lost_reason from
// a fixed vocabulary (BRD §0.7) that NeoDove has no equivalent for, and a
// wrongly-attributed Lost is expensive to unwind. `Converted` is absent because
// conversion here means a real dealer-onboarding record exists, which a
// telecaller marking a dropdown cannot create. Both are surfaced to a human via
// the touchpoint + campaign detail instead.
const STAGE_TO_LEAD_STATUS: Record<string, LeadStatus> = {
    hot: "Under_Discussion",
    warm: "Under_Discussion",
    interested: "Under_Discussion",
    "in discussion": "Under_Discussion",
    "follow up": "Under_Discussion",
    negotiation: "Commercials_Explained",
    "quote sent": "Commercials_Explained",
    "quotation sent": "Commercials_Explained",
    "awaiting decision": "Awaiting_Customer_Decision",
    "decision pending": "Awaiting_Customer_Decision",
};

export function leadStatusFor(event: NeodoveInboundEvent): LeadStatus | null {
    const key = (event.stage ?? event.disposition ?? "").trim().toLowerCase();
    if (!key) return null;
    return STAGE_TO_LEAD_STATUS[key] ?? null;
}

/**
 * Human-readable one-liner for lead_touchpoints.remarks.
 *
 * The agent's name is NOT included any more: it has its own column
 * (external_agent_name, E-226) and the timeline already renders it as
 * "by Rushikesh (NeoDove agent)", so repeating it here produced
 * "… · Agent: Rushikesh" directly under a line that already said so.
 *
 * The numeric code is appended only when there is no readable label to show
 * instead, and is labelled as a code so nobody reads "6" as a disposition.
 */
export function remarksFor(event: NeodoveInboundEvent): string {
    const label =
        event.disposition ??
        (event.dispositionCode ? `status code ${event.dispositionCode}` : null);
    const bits = [
        label ? `Disposition: ${label}` : null,
        event.stage ? `Stage: ${event.stage}` : null,
        event.tag ? `Tag: ${event.tag}` : null,
        // The telecaller's own words, last so they read as the payoff.
        event.remarks ? `“${event.remarks}”` : null,
    ].filter(Boolean);
    return `[NeoDove] ${bits.join(" · ") || event.eventType}`;
}
