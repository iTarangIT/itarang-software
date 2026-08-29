// Unit tests for the NeoDove field mapper (E-224).
//
// This is the highest-risk code in the integration because NeoDove publishes no
// payload schema — parseInboundEvent() is an educated guess. These tests don't
// prove the guess is right (only a captured payload can do that, see
// docs/neodove-contract.md). What they pin down is the behaviour that must hold
// REGARDLESS of what the real shape turns out to be:
//
//   * a payload we don't understand is never rejected — it parses to something
//     storable, because with no read API a refused delivery is unrecoverable
//   * an unrecognised disposition maps to null rather than being guessed at
//   * terminal lead statuses are never inferred from a remote dropdown
//   * the same logical event always produces the same idempotency key

import { describe, expect, it } from "vitest";
import {
    callStatusFor,
    dealerLeadToNeodove,
    dispositionFor,
    leadStatusFor,
    parseInboundEvent,
    remarksFor,
    touchpointTypeFor,
    type PushableLead,
} from "../mapper";

// NeoDove's REAL fixed webhook payload, copied verbatim from the "Example Url
// (Curl)" block on their Integrations > Webhook screen, 2026-08-03. This is no
// longer a guess — it is the authoritative shape for this trigger, and it is why
// the tests below assert exact field names rather than tolerating alternatives.
//
// Seven of the nine keys the parser originally looked for are absent from it:
// the event type is `event_name` (not event/event_type), the timestamp is `time`
// as epoch millis (not timestamp/created_at), the stage is `lead_stage_name`,
// the campaign is a UUID in `campaign_id` with no name anywhere, there is no
// per-event id at all, and there is NO disposition text, NO agent and NO
// recording URL. The last three matter: this trigger structurally cannot deliver
// them, so E-226's recording_url / external_agent_name stay NULL on this path
// and only Workflows > Send Webhook, whose body is author-defined, could carry
// them.
const REAL_DISPOSE_PAYLOAD = {
    name: "Neodove",
    mobile: "9509624540",
    lead_id: "ae8ef37e-c0cd-4e69-b150-55a29b090065",
    campaign_id: "be8ef37e-c0cd-4e69-b150-55a29b090065",
    lead_status: "6",
    call_connected: "false",
    lead_stage_name: "Open",
    time: "1638806214940",
    event_name: "LEAD_DISPOSE",
} as const;

// The FIRST REAL LIVE WEBHOOK, captured verbatim from
// neodove_sync_events.request_payload on 2026-08-03 14:01:15Z. This supersedes
// the sample above wherever they disagree, and they disagree a lot: the live body
// carries `agent_name`, `campaign_name`, `lead_status_name`, `dispose_remarks`,
// `lead_tag_name`, `follow_up_date` and — critically — our own custom fields
// nested under `other_properties`, none of which appear in NeoDove's sample.
//
// Note the types differ from the sample too: `time` and `lead_status` arrive as
// NUMBERS here and as STRINGS there, and `call_connected` is null rather than
// "false". Anything reading these must tolerate both.
const LIVE_DISPOSE_PAYLOAD = {
    name: "E Rikshaw",
    time: 1785765674640,
    mobile: "8269342343",
    lead_id: "e02ad541-c6a9-4c49-a44c-e0d64755e470",
    agent_name: "Rushikesh",
    event_name: "LEAD_DISPOSE",
    agent_email: null,
    campaign_id: "2ee261d1-e7dd-470c-885a-9e8e17cb6e9e",
    lead_status: 6,
    agent_number: "8208677782",
    campaign_name: "CUSTOM_INTEGRATION-campaign",
    lead_tag_name: null,
    call_connected: null,
    follow_up_date: 1785787221858,
    time_formatted: "03/08/2026",
    dispose_remarks: "",
    lead_stage_name: "Cold",
    other_properties: [
        {
            properties: [
                { name: "itarang_lead_id", value: "L-7VOPwrpR" },
                { name: "itarang_shop_name", value: "E Rikshaw" },
                { name: "itarang_city", value: "Ujjain" },
                { name: "itarang_state", value: "Madhya Pradesh" },
                { name: "itarang_area", value: "Jaisinghpura" },
                { name: "itarang_pincode", value: "456006" },
                { name: "itarang_language", value: "hindi" },
            ],
            contact_list_name: "CUSTOM_INTEGRATION",
        },
    ],
    lead_creation_date: "03/08/2026",
    lead_creation_time: "7:28 PM",
    follow_up_date_time: "04/08/2026, 01:30 am",
    custom_contact_properties: null,
    customer_detail_form_response: [],
} as const;

const pushable = (over: Partial<PushableLead> = {}): PushableLead => ({
    id: "DL-1",
    phone: "9876543210",
    dealer_name: "Ramesh Kumar",
    shop_name: "Sharada Enterprises",
    city: "Ujjain",
    state: "Madhya Pradesh",
    area: null,
    pincode: "456001",
    language: "hindi",
    source: "manual_upload_lead",
    lead_status: null,
    interest_level: null,
    ...over,
});

describe("dealerLeadToNeodove", () => {
    it("sends the bare national number under the reserved `mobile` key", () => {
        const out = dealerLeadToNeodove(pushable())!;
        expect(out.mobile).toBe("9876543210");
    });

    it("normalises a messy phone before sending", () => {
        expect(dealerLeadToNeodove(pushable({ phone: "+91 98765-43210" }))!.mobile).toBe(
            "9876543210",
        );
    });

    it("returns null when there is no usable mobile — NeoDove's only required field", () => {
        expect(dealerLeadToNeodove(pushable({ phone: null }))).toBeNull();
        expect(dealerLeadToNeodove(pushable({ phone: "12345" }))).toBeNull();
    });

    it("prefixes CRM fields with itarang_ so they can't collide with reserved keys", () => {
        const out = dealerLeadToNeodove(pushable())!;
        expect(out.itarang_lead_id).toBe("DL-1");
        expect(out.itarang_city).toBe("Ujjain");
        // `name` is reserved and must stay unprefixed.
        expect(out.name).toBe("Ramesh Kumar");
    });

    it("falls back to shop_name when there is no dealer name", () => {
        const out = dealerLeadToNeodove(
            pushable({ dealer_name: null, shop_name: "Sharada Enterprises" }),
        )!;
        expect(out.name).toBe("Sharada Enterprises");
    });

    // Sending blanks would fill the NeoDove lead with empty custom fields that
    // an agent then has to read past.
    it("omits empty and null fields rather than sending blanks", () => {
        const out = dealerLeadToNeodove(
            pushable({ area: null, interest_level: null, pincode: "" }),
        )!;
        expect(out).not.toHaveProperty("itarang_area");
        expect(out).not.toHaveProperty("itarang_interest");
        expect(out).not.toHaveProperty("itarang_pincode");
    });
});

describe("parseInboundEvent — NeoDove's real payload", () => {
    it("classifies event_name, not the absent event/event_type keys", () => {
        // The bug this pins: with event_name unread, EVERY event fell through to
        // the lead_disposed default — so a LEAD_CREATE was routed to
        // handleLeadDisposed, matched no local phone, and landed `unresolved`.
        // The inbound half of the two-way sync was dead, silently.
        expect(parseInboundEvent(REAL_DISPOSE_PAYLOAD).eventType).toBe("lead_disposed");
        expect(
            parseInboundEvent({ ...REAL_DISPOSE_PAYLOAD, event_name: "LEAD_CREATE" })
                .eventType,
        ).toBe("lead_created");
        expect(
            parseInboundEvent({ ...REAL_DISPOSE_PAYLOAD, event_name: "LEAD_DELETE" })
                .eventType,
        ).toBe("lead_deleted");
    });

    it("reads epoch-millis-as-string in `time` as a real date", () => {
        // new Date("1638806214940") is Invalid Date, so this used to be null —
        // which silently degraded dedupe to a 60-second bucket and dropped a
        // genuine second call to the same lead within that minute as a replay.
        expect(parseInboundEvent(REAL_DISPOSE_PAYLOAD).occurredAt?.toISOString()).toBe(
            "2021-12-06T15:56:54.940Z",
        );
    });

    it("takes the campaign UUID when no campaign name is sent", () => {
        const e = parseInboundEvent(REAL_DISPOSE_PAYLOAD);
        expect(e.campaignId).toBe("be8ef37e-c0cd-4e69-b150-55a29b090065");
        expect(e.campaignName).toBeNull();
    });

    it("reads lead_stage_name as the stage", () => {
        expect(parseInboundEvent(REAL_DISPOSE_PAYLOAD).stage).toBe("Open");
        // "Open" is deliberately absent from STAGE_TO_LEAD_STATUS: it is
        // NeoDove's untouched-lead stage and must not move our lead status.
        expect(leadStatusFor(parseInboundEvent(REAL_DISPOSE_PAYLOAD))).toBeNull();
    });

    it("derives a call status from call_connected when no disposition text exists", () => {
        expect(callStatusFor(parseInboundEvent(REAL_DISPOSE_PAYLOAD))).toBe(
            "not_responding",
        );
        expect(
            callStatusFor(
                parseInboundEvent({ ...REAL_DISPOSE_PAYLOAD, call_connected: "true" }),
            ),
        ).toBe("connected");
    });

    it("does not resolve the opaque numeric lead_status to a call status", () => {
        // "6" is carried verbatim in dispositionCode so the raw value stays
        // visible for diagnosis, but it must NOT reach `disposition` (which the
        // UI renders) and must NOT be guessed into a CallStatus — the code table
        // is unpublished.
        const e = parseInboundEvent({
            ...REAL_DISPOSE_PAYLOAD,
            call_connected: "yes",
            lead_status: "6",
        });
        expect(e.dispositionCode).toBe("6");
        expect(e.disposition).toBeNull();
        // Resolution comes from call_connected, never from the "6".
        expect(callStatusFor(e)).toBe("connected");
    });

    it("synthesises a stable id, since the payload carries none", () => {
        const a = parseInboundEvent(REAL_DISPOSE_PAYLOAD).externalEventId;
        const b = parseInboundEvent({ ...REAL_DISPOSE_PAYLOAD }).externalEventId;
        expect(a).toBe(b);
        expect(a.startsWith("syn_")).toBe(true);
        // A different call to the same lead one second later is a DIFFERENT
        // event, not a replay.
        expect(
            parseInboundEvent({ ...REAL_DISPOSE_PAYLOAD, time: "1638806215940" })
                .externalEventId,
        ).not.toBe(a);
    });

    it("keeps agent and recording null — this trigger cannot supply them", () => {
        const e = parseInboundEvent(REAL_DISPOSE_PAYLOAD);
        expect(e.agentName).toBeNull();
        expect(e.recordingUrl).toBeNull();
    });
});

describe("parseInboundEvent — the first REAL live webhook", () => {
    it("recovers itarang_lead_id from the nested other_properties array", () => {
        // The designed join key. It survives someone editing the phone number in
        // NeoDove, which neither `mobile` nor NeoDove's `lead_id` does — and it
        // was being ignored entirely because it is nested, not flat.
        expect(parseInboundEvent(LIVE_DISPOSE_PAYLOAD).itarangLeadId).toBe("L-7VOPwrpR");
    });

    it("never lets a custom field shadow a real top-level key", () => {
        // A human can type anything into a NeoDove custom field. If one is named
        // `mobile`, THEIRS must lose — otherwise editing a custom field could
        // silently re-point a call at a different lead.
        const e = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            other_properties: [
                { properties: [{ name: "mobile", value: "9999999999" }] },
            ],
        });
        expect(e.mobile).toBe("+918269342343");
    });

    it("shows a readable disposition, never the bare numeric code", () => {
        // "Disposition: 6" was on screen. 6 is NeoDove's internal status id.
        const withName = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            lead_status_name: "Interested",
        });
        expect(withName.disposition).toBe("Interested");
        expect(remarksFor(withName)).toContain("Disposition: Interested");
        expect(remarksFor(withName)).not.toContain("Disposition: 6");

        // With no readable label, the code is LABELLED as a code rather than
        // being passed off as a disposition.
        const codeOnly = parseInboundEvent(LIVE_DISPOSE_PAYLOAD);
        expect(codeOnly.dispositionCode).toBe("6");
        expect(remarksFor(codeOnly)).toContain("status code 6");
    });

    it("carries dispose_remarks — the reason the telecaller typed", () => {
        const e = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            dispose_remarks: "Wants a callback after Diwali",
        });
        expect(e.remarks).toBe("Wants a callback after Diwali");
        expect(remarksFor(e)).toContain("Wants a callback after Diwali");
    });

    it("stops repeating the agent name inside remarks", () => {
        // The timeline already renders "by Rushikesh (NeoDove agent)" above the
        // remarks line, so "· Agent: Rushikesh" said it twice.
        const e = parseInboundEvent(LIVE_DISPOSE_PAYLOAD);
        expect(e.agentName).toBe("Rushikesh");
        expect(remarksFor(e)).not.toContain("Agent: Rushikesh");
    });

    it("handles numeric time and numeric lead_status, not just strings", () => {
        const e = parseInboundEvent(LIVE_DISPOSE_PAYLOAD);
        expect(e.occurredAt?.toISOString()).toBe("2026-08-03T14:01:14.640Z");
        expect(e.dispositionCode).toBe("6");
    });

    it("reads campaign_name when present and still keeps campaign_id", () => {
        const e = parseInboundEvent(LIVE_DISPOSE_PAYLOAD);
        expect(e.campaignName).toBe("CUSTOM_INTEGRATION-campaign");
        expect(e.campaignId).toBe("2ee261d1-e7dd-470c-885a-9e8e17cb6e9e");
    });

    it("leaves call_status null when call_connected is null", () => {
        // null is "not told", NOT "did not connect" — asBool must not coerce it
        // to false, which would fabricate a not_responding outcome.
        const e = parseInboundEvent(LIVE_DISPOSE_PAYLOAD);
        expect(e.callConnected).toBeNull();
        expect(callStatusFor(e)).toBeNull();
    });

    it("does not move our lead status off NeoDove's Cold stage", () => {
        expect(leadStatusFor(parseInboundEvent(LIVE_DISPOSE_PAYLOAD))).toBeNull();
    });

    it("classifies the near-empty LEAD_CREATE NeoDove also fires", () => {
        // Observed live: a second LEAD_CREATE arrives with no mobile, no name and
        // no campaign. It must classify correctly and parse without throwing —
        // handleLeadCreated then rejects it for having no usable mobile, which is
        // the right outcome and is recorded rather than silently dropped.
        const e = parseInboundEvent({
            time: 1785765674749,
            lead_id: "1a6df560-4c13-4170-90bf-1d92a8fdceed",
            agent_name: "",
            event_name: "LEAD_CREATE",
            lead_status_name: "Open",
            other_properties: null,
        });
        expect(e.eventType).toBe("lead_created");
        expect(e.mobile).toBeNull();
        expect(e.itarangLeadId).toBeNull();
    });
});

describe("parseInboundEvent", () => {
    it("parses a plausible disposition payload", () => {
        const e = parseInboundEvent({
            event: "lead_dispose",
            event_id: "evt_123",
            mobile: "9876543210",
            campaign: "Dealer Q3",
            disposition: "Interested",
            agent: "Priya",
            duration: 142,
            remarks: "Wants a callback Monday",
            timestamp: "2026-08-01T10:30:00Z",
        });

        expect(e.eventType).toBe("lead_disposed");
        expect(e.externalEventId).toBe("evt_123");
        expect(e.mobile).toBe("+919876543210");
        expect(e.campaignName).toBe("Dealer Q3");
        expect(e.disposition).toBe("Interested");
        expect(e.agentName).toBe("Priya");
        expect(e.callDurationSec).toBe(142);
        expect(e.occurredAt?.toISOString()).toBe("2026-08-01T10:30:00.000Z");
    });

    it("reads camelCase and snake_case interchangeably", () => {
        const camel = parseInboundEvent({
            eventType: "call_connected",
            eventId: "e1",
            mobileNumber: "9876543210",
            campaignName: "X",
            callDuration: 30,
        });
        expect(camel.eventType).toBe("call_connected");
        expect(camel.externalEventId).toBe("e1");
        expect(camel.mobile).toBe("+919876543210");
        expect(camel.callDurationSec).toBe(30);
    });

    it("unwraps a single level of data/lead/payload nesting", () => {
        const e = parseInboundEvent({
            event: "lead_created",
            data: { mobile: "9876543210", name: "Ramesh", city: "Ujjain" },
        });
        expect(e.eventType).toBe("lead_created");
        expect(e.mobile).toBe("+919876543210");
        expect(e.name).toBe("Ramesh");
    });

    it("classifies every documented trigger", () => {
        const cases: [string, string][] = [
            ["lead created", "lead_created"],
            ["Lead Delete", "lead_deleted"],
            ["call connected", "call_connected"],
            ["call not connected", "call_not_connected"],
            ["lead_dispose", "lead_disposed"],
        ];
        for (const [input, expected] of cases) {
            expect(parseInboundEvent({ event: input }).eventType).toBe(expected);
        }
    });

    // The critical property: with no read API, refusing a delivery loses it
    // forever. An unrecognised payload must still produce something storable.
    it("never throws on an unrecognised or empty payload", () => {
        for (const input of [{}, null, undefined, [], "string", 42, { junk: true }]) {
            const e = parseInboundEvent(input);
            expect(e.externalEventId).toBeTruthy();
            expect(e.raw).toBe(input);
        }
    });

    it("preserves the raw payload verbatim so a wrong guess is recoverable", () => {
        const raw = { weird: { nested: ["shape"] } };
        expect(parseInboundEvent(raw).raw).toBe(raw);
    });

    it("synthesises a STABLE id when NeoDove sends none", () => {
        const body = {
            event: "lead_dispose",
            mobile: "9876543210",
            campaign: "Dealer Q3",
            timestamp: "2026-08-01T10:30:00Z",
        };
        const a = parseInboundEvent(body).externalEventId;
        const b = parseInboundEvent({ ...body }).externalEventId;
        expect(a).toBe(b);
        expect(a.startsWith("syn_")).toBe(true);
    });

    it("gives genuinely different events different synthetic ids", () => {
        const base = {
            event: "lead_dispose",
            mobile: "9876543210",
            campaign: "Dealer Q3",
            timestamp: "2026-08-01T10:30:00Z",
        };
        const other = parseInboundEvent({
            ...base,
            timestamp: "2026-08-01T11:00:00Z",
        });
        expect(parseInboundEvent(base).externalEventId).not.toBe(
            other.externalEventId,
        );
    });

    it("leaves mobile null when the number is unusable", () => {
        expect(parseInboundEvent({ mobile: "12345" }).mobile).toBeNull();
        expect(parseInboundEvent({}).mobile).toBeNull();
    });
});

describe("callStatusFor", () => {
    const ev = (over: Record<string, unknown>) => parseInboundEvent(over);

    it("maps common dispositions", () => {
        expect(callStatusFor(ev({ disposition: "Interested" }))).toBe("connected");
        expect(callStatusFor(ev({ disposition: "not reachable" }))).toBe(
            "not_reachable",
        );
        expect(callStatusFor(ev({ disposition: "Wrong Number" }))).toBe(
            "incorrect_number",
        );
        expect(callStatusFor(ev({ disposition: "busy" }))).toBe("not_responding");
    });

    it("derives status from the event when there is no disposition", () => {
        expect(callStatusFor(ev({ event: "call_connected" }))).toBe("connected");
        expect(callStatusFor(ev({ event: "call not connected" }))).toBe(
            "not_responding",
        );
    });

    // Dispositions are configured per-account in NeoDove's UI, so the map can
    // never be exhaustive. Guessing would silently corrupt call reporting.
    it("returns null for an unrecognised disposition rather than guessing", () => {
        expect(callStatusFor(ev({ disposition: "Sent Brochure Via Courier" }))).toBeNull();
    });
});

describe("leadStatusFor", () => {
    it("maps known stages to open statuses", () => {
        expect(leadStatusFor(parseInboundEvent({ stage: "hot" }))).toBe(
            "Under_Discussion",
        );
        expect(leadStatusFor(parseInboundEvent({ stage: "quote sent" }))).toBe(
            "Commercials_Explained",
        );
    });

    it("returns null for unknown stages", () => {
        expect(leadStatusFor(parseInboundEvent({ stage: "Mysterious" }))).toBeNull();
        expect(leadStatusFor(parseInboundEvent({}))).toBeNull();
    });

    // Lost needs a lost_reason from a fixed vocabulary NeoDove has no
    // equivalent for; Converted means a real onboarding record exists, which a
    // telecaller ticking a dropdown cannot create. Both must reach a human.
    it("NEVER infers a terminal status from a remote stage", () => {
        for (const stage of ["lost", "Lost", "converted", "Converted", "won", "closed"]) {
            expect(leadStatusFor(parseInboundEvent({ stage }))).toBeNull();
        }
    });
});

describe("touchpointTypeFor", () => {
    // Mapping these to `ai_call` would corrupt the BRD §0.11 AI-vs-human
    // reporting split — a NeoDove campaign is a person dialling.
    it("records NeoDove calls as human inside-sales calls, never AI calls", () => {
        for (const t of ["call_connected", "call_not_connected", "lead_disposed"] as const) {
            expect(touchpointTypeFor(t)).toBe("inside_sales_call");
        }
    });

    it("records lifecycle events as status notes", () => {
        expect(touchpointTypeFor("lead_created")).toBe("status_change_note");
        expect(touchpointTypeFor("lead_deleted")).toBe("status_change_note");
    });
});

describe("remarksFor", () => {
    it("tags the source and folds in the useful context", () => {
        const r = remarksFor(
            parseInboundEvent({
                disposition: "Interested",
                agent: "Priya",
                remarks: "Callback Monday",
            }),
        );
        expect(r).toContain("[NeoDove]");
        expect(r).toContain("Interested");
        expect(r).toContain("Callback Monday");
    });

    it("deliberately OMITS the agent name", () => {
        // Changed 2026-08-03. The agent has had its own column since E-226
        // (external_agent_name) and both the Activity timeline and the Call
        // History row render it as "by Priya", so including it here printed the
        // name twice, one line apart. Asserted rather than merely dropped so
        // nobody "restores" it later.
        const r = remarksFor(
            parseInboundEvent({ disposition: "Interested", agent_name: "Priya" }),
        );
        expect(r).not.toContain("Priya");
    });

    it("still produces something useful for an empty event", () => {
        expect(remarksFor(parseInboundEvent({}))).toContain("[NeoDove]");
    });
});

// E-226. The recording URL is rendered as a link and fed straight to an <audio>
// element, so what matters is not only that a real URL survives every plausible
// key spelling, but that anything which is NOT a URL is treated as absent —
// NeoDove's fields are customer-configured free text, and a broken player is
// worse than no player.
describe("parseInboundEvent — recording URL (E-226)", () => {
    it("reads a recording from each spelling NeoDove might use", () => {
        const url = "https://recordings.neodove.com/abc123.mp3";
        for (const key of [
            "recording_url",
            "recordingUrl",
            "recording",
            "call_recording",
            "callRecording",
            "recording_link",
            "audio_url",
            "audioUrl",
        ]) {
            expect(parseInboundEvent({ [key]: url }).recordingUrl).toBe(url);
        }
    });

    it("finds it inside a nested data envelope", () => {
        expect(
            parseInboundEvent({
                event: "call connected",
                data: { recording_url: "http://cdn.example.com/x.wav" },
            }).recordingUrl,
        ).toBe("http://cdn.example.com/x.wav");
    });

    it("treats non-URLs as absent rather than passing them to the player", () => {
        for (const junk of ["NA", "yes", "", "/relative/path.mp3", "not a url"]) {
            expect(parseInboundEvent({ recording_url: junk }).recordingUrl).toBeNull();
        }
    });

    it("refuses a non-http scheme", () => {
        expect(
            parseInboundEvent({ recording_url: "javascript:alert(1)" }).recordingUrl,
        ).toBeNull();
        expect(
            parseInboundEvent({ recording_url: "ftp://example.com/a.mp3" }).recordingUrl,
        ).toBeNull();
    });

    it("is null when the payload carries no recording at all", () => {
        expect(parseInboundEvent({ disposition: "Interested" }).recordingUrl).toBeNull();
    });
});

// ── The CC sheet, end to end through the parser (E-236) ───────────────────
//
// dispositions.test.ts proves the taxonomy classifies correctly given a string.
// These prove the string is pulled out of a NeoDove payload at all — which is
// the half that was wrong for months: the disposition arrives in
// `lead_tag_name`, and every reader looked at `lead_status_name` first.

describe("dispositionFor", () => {
    it("reads lead_tag_name in preference to lead_status_name", () => {
        // This IS the live account's shape: a generic status label and the real
        // disposition in the tag. Reading `disposition` first classified almost
        // every genuine call as unmapped.
        const event = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            lead_tag_name: "Price High",
            lead_status_name: "Open",
        });
        const hit = dispositionFor(event);
        expect(hit?.label).toBe("Price High");
        expect(hit?.bucket).toBe("Warm");
        expect(hit?.isKnown).toBe(true);
    });

    it("falls back to lead_status_name when the tag is absent", () => {
        const event = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            lead_tag_name: null,
            lead_status_name: "Not Interested",
        });
        expect(dispositionFor(event)?.label).toBe("Not Interested");
        expect(dispositionFor(event)?.bucket).toBe("Lost");
    });

    it("falls back to dispose_remarks only on an EXACT match", () => {
        const typed = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            lead_tag_name: null,
            dispose_remarks: "Onboarding Done",
        });
        expect(dispositionFor(typed)?.label).toBe("Onboarding Done");

        // Prose must never become a disposition label — it would pollute the
        // filter dropdown with one option per sentence anyone ever typed. So an
        // unmatched remark yields NOTHING rather than an unmapped disposition:
        // remarks are consulted for an exact hit only, never as the fallback.
        const prose = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            lead_tag_name: null,
            dispose_remarks: "he asked us to call back after diwali",
        });
        expect(dispositionFor(prose)).toBeNull();
    });

    it("uses lead_stage_name to settle the Warm/Hot ambiguity", () => {
        const warm = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            lead_tag_name: "Commercials Explained",
            lead_stage_name: "Cold",
        });
        expect(dispositionFor(warm)?.bucket).toBe("Warm");

        const hot = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            lead_tag_name: "Commercials Explained",
            lead_stage_name: "Hot",
        });
        expect(dispositionFor(hot)?.bucket).toBe("Hot");
    });

    it("keeps an unmapped tag rather than discarding it", () => {
        const event = parseInboundEvent({
            ...LIVE_DISPOSE_PAYLOAD,
            lead_tag_name: "Sent to field team",
        });
        expect(dispositionFor(event)?.label).toBe("Sent to field team");
        expect(dispositionFor(event)?.isKnown).toBe(false);
    });

    it("refuses to invent a disposition out of NeoDove's STATUS vocabulary", () => {
        // lead_status_name is Open / Follow-Up / Closed — real values, but
        // statuses, not dispositions. Across 2,178 stored webhooks, allowing
        // them through put "Open" (17), "Follow-Up" (10), "Closed" (4) and the
        // bare code "6" into the filter dropdown as if a telecaller had chosen
        // them. They are still honoured when they match the sheet; they just
        // cannot supply an unmapped value of their own.
        for (const status of ["Open", "Follow-Up", "Closed", "6"]) {
            const event = parseInboundEvent({
                ...LIVE_DISPOSE_PAYLOAD,
                lead_tag_name: null,
                lead_status_name: status,
            });
            expect(dispositionFor(event), status).toBeNull();
        }
    });

    it("is null when the payload names no disposition at all", () => {
        // The live fixture is exactly this: tag null, no lead_status_name.
        expect(dispositionFor(parseInboundEvent(LIVE_DISPOSE_PAYLOAD))).toBeNull();
    });
});

describe("callStatusFor, driven by the sheet", () => {
    const withTag = (tag: string, extra: Record<string, unknown> = {}) =>
        parseInboundEvent({ ...LIVE_DISPOSE_PAYLOAD, lead_tag_name: tag, ...extra });

    it("treats every connected disposition as connected", () => {
        for (const tag of ["Price High", "REJECTED BY US", "Order Received"]) {
            expect(callStatusFor(withTag(tag)), tag).toBe("connected");
        }
    });

    it("treats Short Hang up as connected, per the sheet", () => {
        // A hang-up after one second still connected. Filing it under
        // not_responding would understate the connect rate.
        expect(callStatusFor(withTag("Short Hang up"))).toBe("connected");
    });

    it("maps each not-connected reason to its own CallStatus", () => {
        expect(callStatusFor(withTag("Did not pick"))).toBe("not_responding");
        expect(callStatusFor(withTag("Switch off"))).toBe("not_reachable");
        expect(callStatusFor(withTag("Number not in use / does not exist / out of service"))).toBe(
            "not_reachable",
        );
        expect(callStatusFor(withTag("Incorrect / Invalid number"))).toBe(
            "incorrect_number",
        );
        expect(callStatusFor(withTag("Incoming calls not available"))).toBe(
            "no_incoming",
        );
    });

    it("lets the disposition explain WHY a call_not_connected event failed", () => {
        // Before the sheet, every one of these was a flat not_responding.
        const event = withTag("Switch off", { event_name: "CALL_NOT_CONNECTED" });
        expect(event.eventType).toBe("call_not_connected");
        expect(callStatusFor(event)).toBe("not_reachable");
    });

    it("does not let a connected tag overturn a call_not_connected event", () => {
        // NeoDove fires that event from the dialler, not from a dropdown. When
        // the two disagree the mechanical fact wins and the tag is stale.
        const event = withTag("Price High", { event_name: "CALL_NOT_CONNECTED" });
        expect(callStatusFor(event)).toBe("not_responding");
    });

    it("still falls back to the stock vocabulary for values outside the sheet", () => {
        expect(callStatusFor(parseInboundEvent({ disposition: "Interested" }))).toBe(
            "connected",
        );
        expect(callStatusFor(parseInboundEvent({ disposition: "not reachable" }))).toBe(
            "not_reachable",
        );
    });

    it("falls back to call_connected when nothing is recognisable", () => {
        expect(
            callStatusFor(
                parseInboundEvent({ disposition: "Sent to field team", call_connected: true }),
            ),
        ).toBe("connected");
        expect(
            callStatusFor(
                parseInboundEvent({ disposition: "Sent to field team", call_connected: false }),
            ),
        ).toBe("not_responding");
    });
});

describe("the disposition never moves the pipeline", () => {
    it("leaves lead_status alone for Converted and Lost dispositions", () => {
        // Deliberate, and the reason STAGE_TO_LEAD_STATUS omits both: our Lost
        // transition needs a lost_reason from a fixed vocabulary NeoDove has no
        // equivalent for, and Converted means a real onboarding record exists,
        // which a telecaller ticking a dropdown cannot create.
        for (const tag of ["Deal Closed", "Onboarding Done", "REJECTED BY US", "Not Interested"]) {
            const event = parseInboundEvent({
                ...LIVE_DISPOSE_PAYLOAD,
                lead_tag_name: tag,
                lead_stage_name: tag === "Deal Closed" ? "Converted" : "Lost",
            });
            expect(leadStatusFor(event), tag).toBeNull();
        }
    });
});
