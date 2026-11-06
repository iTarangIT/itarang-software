import { describe, expect, it } from "vitest";
import {
    dealerTurnsAfterOpener,
    endedBy,
    extractSipCode,
    isHumanDisposition,
    languageFlipped,
    mapDispositionV3,
    redialHints,
    type DispositionV3Input,
} from "../dispositionV3";
import { classifyDisposition } from "@/lib/leads/dispositions";

const failed = (failureText: string, extra: Partial<DispositionV3Input> = {}) =>
    mapDispositionV3({ callEndStatus: "failed", failureText, ...extra });
const human = (extra: Partial<DispositionV3Input> = {}) =>
    mapDispositionV3({ callEndStatus: "completed", answeredBy: "owner", dealerSpoke: true, ...extra });

describe("extractSipCode", () => {
    it.each([
        ["trigger_failed: INVITE failed: sip status: 486: Busy Here", 486],
        ["sip status:480", 480],
        ["SIP 503 Service Unavailable", 503],
        ["SipResponseCode=404", 404],
        ["sip_status_code: 603", 603],
        ["sip-status 410 Gone", 410],
    ])("%s → %d", (text, code) => {
        expect(extractSipCode(text)).toBe(code);
    });

    it("accepts a bare SIP-range number, string or numeric", () => {
        expect(extractSipCode(487)).toBe(487);
        expect(extractSipCode("403")).toBe(403);
    });

    it("ignores out-of-range numbers and text without a SIP code", () => {
        expect(extractSipCode(42, "999", "HTTP 500 from ElevenLabs", null, undefined, "")).toBeNull();
        expect(extractSipCode("sip status: 4860")).toBeNull();
    });

    it("first source with a code wins", () => {
        expect(extractSipCode(null, "no code here", "sip status: 486", 480)).toBe(486);
    });
});

describe("endedBy", () => {
    it.each([
        ["Call ended by remote party", "dealer"],
        ["Client disconnected: 1000", "dealer"],
        ["end_call tool was called.", "priya"],
        ["Silence timeout reached", "priya"],
        ["Maximum duration exceeded", "priya"],
        ["Voicemail detected", "priya"],
        ["SIP transport error", "line"],
        ["websocket connection lost", "line"],
    ] as const)("%s → %s", (reason, who) => {
        expect(endedBy(reason)).toBe(who);
    });

    it("is null for empty or unrecognised reasons", () => {
        expect(endedBy(null)).toBeNull();
        expect(endedBy("   ")).toBeNull();
        expect(endedBy("conversation finished")).toBeNull();
    });
});

describe("dealerTurnsAfterOpener", () => {
    it("ignores greetings, punctuation-only turns, and turns before the opener", () => {
        const t = [
            "user: hello?",
            "agent: नमस्ते sir, मैं Priya बोल रही हूँ।",
            "user: Hello? हाँ",
            "user: ...",
            "user: हाँ, बोलिए, क्या काम है आपको भाई",
        ].join("\n");
        expect(dealerTurnsAfterOpener(t)).toBe(1);
    });

    it("is 0 when the agent never spoke or the transcript is empty", () => {
        expect(dealerTurnsAfterOpener("user: हाँ बोलिए बताइए क्या बात है")).toBe(0);
        expect(dealerTurnsAfterOpener(null)).toBe(0);
    });
});

describe("languageFlipped", () => {
    const flip = [
        "agent: नमस्ते sir, मैं Priya बोल रही हूँ।",
        "user: Hello.",
        "agent: Hello sir, I am calling from iTarang about lithium batteries.",
    ].join("\n");

    it("an all-English agent turn after a Hindi dealer spoke is a flip", () => {
        expect(languageFlipped(flip, "hi")).toBe(true);
    });

    it("Hinglish (Devanagari with English words) is not a flip", () => {
        const t = "agent: नमस्ते\nuser: हाँ\nagent: आप 3W lithium batteries में deal करते हैं sir?";
        expect(languageFlipped(t, "hi")).toBe(false);
    });

    it("an English dealer, an unknown language, or a short Latin reply is not a flip", () => {
        expect(languageFlipped(flip, "en")).toBe(false);
        expect(languageFlipped(flip, "unknown")).toBe(false);
        expect(languageFlipped(flip, null)).toBe(false);
        expect(languageFlipped("agent: नमस्ते\nuser: haan\nagent: OK sir.", "hi")).toBe(false);
    });

    it("English before the dealer has spoken (the opener) is not a flip", () => {
        expect(languageFlipped("agent: Hello sir, this is Priya from iTarang.\nuser: हाँ", "hi")).toBe(false);
    });
});

describe("mapDispositionV3 — rules 1–6, the dial failed", () => {
    it("1: SIP 486 / 600 / busy without a code → Busy in another call", () => {
        expect(failed("sip status: 486: Busy Here").l2).toBe("Busy in another call");
        expect(failed("sip status: 600").rule).toBe("1");
        expect(mapDispositionV3({ callEndStatus: "busy" }).rule).toBe("1");
    });

    it("2: SIP 480 / 487 / ring timeout → Did not pick", () => {
        expect(failed("sip status: 480: Temporarily Unavailable").l2).toBe("Did not pick");
        expect(failed("sip status: 487 Request Terminated").rule).toBe("2");
        expect(failed("ring timeout").rule).toBe("2");
        expect(mapDispositionV3({ callEndStatus: "no_response" }).rule).toBe("2");
    });

    it("2b: a carrier 'switched off' recording → Switch off", () => {
        const d = mapDispositionV3({ callEndStatus: "no_response", callEndOutcome: "out_of_service" });
        expect([d.l2, d.rule]).toEqual(["Switch off", "2b"]);
    });

    it("3: SIP 404 / 410 / 484 / 604 or an invalid-number announcement retires the number", () => {
        for (const code of [404, 410, 484, 604]) {
            const d = failed(`sip status: ${code}`);
            expect(d.l2).toBe("Number not in use / does not exist / out of service");
            expect(d.effects.retireNumber).toBe("number");
        }
        expect(mapDispositionV3({ callEndStatus: "failed", callEndOutcome: "invalid_number" }).rule).toBe("3");
    });

    it("4: SIP 401 / 403 / 407 / 429 / 503 → Call not connected, counts as a carrier refusal", () => {
        for (const code of [401, 403, 407, 429, 503]) {
            const d = failed(`sip status: ${code}`);
            expect(d.rule).toBe("4");
            expect(d.effects.carrierRefusal).toBe(true);
        }
    });

    it("4 never fires for 486 / 480 / 404", () => {
        for (const code of [486, 480, 404]) expect(failed(`sip status: ${code}`).effects.carrierRefusal).toBeUndefined();
    });

    it("5: SIP 603, a rejected status, or a cancelled ring → User disconnected the call", () => {
        expect(failed("sip status: 603 Decline").l2).toBe("User disconnected the call");
        expect(mapDispositionV3({ callEndStatus: "rejected" }).rule).toBe("5");
        expect(failed("call cancelled by callee during ring").effects.rejectCounter).toBe(true);
    });

    it("6: any other code → Other reason, and the code is kept", () => {
        const d = failed("sip status: 502 Bad Gateway");
        expect([d.l2, d.sipCode]).toEqual(["Other reason", 502]);
        expect(failed("").rule).toBe("6");
    });

    it("an explicit sipCode beats the text", () => {
        expect(failed("sip status: 480", { sipCode: 486 }).rule).toBe("1");
    });

    it("not-connected results carry no bucket and no L3", () => {
        const d = failed("sip status: 486");
        expect([d.l1, d.bucket, d.l3, d.connectStatus]).toEqual(["Not Connected", null, null, "not_connected"]);
    });
});

describe("mapDispositionV3 — rules 7–11, machines and wrong numbers", () => {
    it("7: call_result wrong_number is Not Connected even on an answered call", () => {
        const d = human({ callResult: "wrong_number" });
        expect([d.l1, d.l2, d.rule]).toEqual(["Not Connected", "Incorrect / Invalid number", "7"]);
        expect(d.effects.numberFix).toBe(true);
    });

    it("7 beats 8: a wrong-number verdict wins over a switchboard answer", () => {
        expect(human({ callResult: "wrong_number", answeredBy: "switchboard_or_recording" }).rule).toBe("7");
    });

    it("8: switchboard_or_recording (result, answered_by, or the classifier) → IVR, retired for the campaign", () => {
        expect(human({ callResult: "switchboard_or_recording" }).l3).toBe("IVR / auto-attendant");
        expect(human({ answeredBy: "switchboard_or_recording" }).rule).toBe("8");
        const legacy = mapDispositionV3({ callEndStatus: "switchboard" });
        expect([legacy.rule, legacy.effects.retireNumber]).toEqual(["8", "campaign"]);
    });

    it("9: personal voicemail or a left message → Recording / voicemail", () => {
        expect(human({ answeredBy: "personal_voicemail" }).l3).toBe("Recording / voicemail");
        expect(human({ callResult: "voicemail_message_left" }).rule).toBe("9");
        expect(mapDispositionV3({ callEndStatus: "voicemail" }).rule).toBe("9");
    });

    it("10 / 11: nobody spoke — 14 s is the boundary, and only Priya-or-unknown ending is a tracking number", () => {
        const base = { callEndStatus: "silent", answeredBy: "nobody_spoke" };
        expect(mapDispositionV3({ ...base, durationSecs: 13.9, endedBy: "priya" }).rule).toBe("11");
        const tracking = mapDispositionV3({ ...base, durationSecs: 14, endedBy: "priya" });
        expect([tracking.rule, tracking.effects.findShopMobile]).toEqual(["10", true]);
        expect(mapDispositionV3({ ...base, durationSecs: 30, endedBy: null }).rule).toBe("10");
        // ≥ 14 s but the dealer / the line ended it: no voice either way → dead audio.
        expect(mapDispositionV3({ ...base, durationSecs: 30, endedBy: "dealer" }).rule).toBe("11");
        expect(mapDispositionV3({ ...base, durationSecs: 30, endedBy: "line" }).rule).toBe("11");
        // No duration: cannot prove a tracking number.
        expect(mapDispositionV3({ ...base, durationSecs: null }).rule).toBe("11");
    });

    it("old agent (no data collection): a silent line is nobody_spoke; an Early Hang-up is a person", () => {
        expect(mapDispositionV3({ callEndStatus: "silent", durationSecs: 20 }).rule).toBe("10");
        expect(mapDispositionV3({ callEndStatus: "hung_up", durationSecs: 4 }).rule).toBe("11");
        const early = mapDispositionV3({
            callEndStatus: "hung_up",
            callEndOutcome: "early_hangup",
            durationSecs: 9,
            dealerSpoke: true,
        });
        expect(early.l3).toBe("Hung up during intro");
    });

    it("Machine rows are not humans; rule 7 is", () => {
        expect(isHumanDisposition(human({ callResult: "switchboard_or_recording" }))).toBe(false);
        expect(isHumanDisposition(human({ callResult: "wrong_number" }))).toBe(true);
        expect(isHumanDisposition(failed("sip status: 486"))).toBe(false);
        expect(isHumanDisposition(human())).toBe(true);
    });
});

describe("mapDispositionV3 — rules 12–20, a person answered", () => {
    it("12: a callback (data collection or analysis) → Warm / Information Collected", () => {
        const d = human({ callbackAgreed: true });
        expect([d.l2, d.l3, d.rule]).toEqual(["Warm", "Information Collected", "12"]);
        expect(human({ callResult: "callback_booked" }).rule).toBe("12");
    });

    it("first match wins: a callback beats not_interested; a machine beats a callback", () => {
        expect(human({ callbackAgreed: true, callResult: "not_interested" }).rule).toBe("12");
        expect(human({ callbackAgreed: true, answeredBy: "personal_voicemail" }).rule).toBe("9");
    });

    it("13: not_a_fit → Lost / REJECTED BY US; 13b: other_business → Some other Business", () => {
        expect(human({ callResult: "not_a_fit" }).l3).toBe("REJECTED BY US");
        expect(human({ answeredBy: "other_business" }).l3).toBe("Some other Business");
    });

    it("14: not_interested → Lost / Not Interested; 14b: complaint → Bad Experience with Trontek", () => {
        expect(human({ callResult: "not_interested" }).l3).toBe("Not Interested");
        expect(human({ callResult: "complaint" }).l3).toBe("Bad Experience with Trontek");
    });

    it("15: asked to be called later with no agreed time → Ask to Call Back", () => {
        expect(human({ askedToCallLater: true }).l3).toBe("Ask to Call Back");
        expect(human({ callResult: "busy_call_later" }).rule).toBe("15");
    });

    it("16: a flip, or a language Priya does not hold → Language mismatch", () => {
        expect(human({ languageFlip: true }).l3).toBe("Language mismatch");
        expect(human({ callLanguage: "ta" }).rule).toBe("16");
        expect(human({ callLanguage: "hi" }).rule).not.toBe("16");
        expect(human({ callLanguage: "unknown" }).rule).not.toBe("16");
    });

    it("17: talked, no close, not ended by Priya → Dropped mid-call", () => {
        expect(human({ dealerTurnsAfterOpener: 2, endedBy: "dealer" }).l3).toBe("Dropped mid-call");
        expect(human({ dealerTurnsAfterOpener: 1, endedBy: "line", callResult: "other" }).rule).toBe("17");
        // Priya closed it, or nobody knows who did: not a drop.
        expect(human({ dealerTurnsAfterOpener: 3, endedBy: "priya" }).rule).toBe("20");
        expect(human({ dealerTurnsAfterOpener: 3, endedBy: null }).rule).toBe("20");
        // A closing result is not a drop even when the dealer hung up.
        expect(human({ dealerTurnsAfterOpener: 3, endedBy: "dealer", callResult: "owner_not_available" }).rule).toBe("18");
    });

    it("18: staff or family, or owner not available, with no callback → Wrong person", () => {
        const d = human({ answeredBy: "staff_or_family" });
        expect([d.l3, d.effects.askOwnerMobile]).toEqual(["Wrong person (staff / family)", true]);
        expect(human({ callResult: "owner_not_available" }).rule).toBe("18");
        expect(human({ answeredBy: "staff_or_family", callbackAgreed: true }).rule).toBe("12");
    });

    it("19: no_conversation under 15 s → Hung up during intro (15 s is the boundary)", () => {
        expect(human({ callResult: "no_conversation", durationSecs: 14.9 }).rule).toBe("19");
        expect(human({ callResult: "no_conversation", durationSecs: 15 }).rule).toBe("20");
        expect(human({ callResult: "no_conversation", durationSecs: null }).rule).toBe("20");
        expect(human({ callResult: "no_conversation", durationSecs: 6 }).effects.shortOpener).toBe(true);
    });

    it("20: anything else with a person → Need Some Time, flagged for review", () => {
        const d = human({ callResult: "other", durationSecs: 60 });
        expect([d.l3, d.effects.manualReview]).toEqual(["Need Some Time", true]);
    });
});

describe("every v3 label exists in the CRM vocabulary", () => {
    const samples: DispositionV3Input[] = [
        { callEndStatus: "failed", failureText: "sip status: 486" },
        { callEndStatus: "failed", failureText: "sip status: 480" },
        { callEndStatus: "no_response", callEndOutcome: "out_of_service" },
        { callEndStatus: "failed", failureText: "sip status: 404" },
        { callEndStatus: "failed", failureText: "sip status: 503" },
        { callEndStatus: "failed", failureText: "sip status: 603" },
        { callEndStatus: "failed", failureText: "sip status: 502" },
        { callEndStatus: "completed", callResult: "wrong_number" },
        { callEndStatus: "switchboard" },
        { callEndStatus: "voicemail" },
        { callEndStatus: "silent", durationSecs: 20 },
        { callEndStatus: "silent", durationSecs: 3 },
        { callEndStatus: "completed", dealerSpoke: true, callbackAgreed: true },
        { callEndStatus: "completed", dealerSpoke: true, callResult: "not_a_fit" },
        { callEndStatus: "completed", dealerSpoke: true, answeredBy: "other_business" },
        { callEndStatus: "completed", dealerSpoke: true, callResult: "not_interested" },
        { callEndStatus: "completed", dealerSpoke: true, callResult: "complaint" },
        { callEndStatus: "completed", dealerSpoke: true, askedToCallLater: true },
        { callEndStatus: "completed", dealerSpoke: true, languageFlip: true },
        { callEndStatus: "completed", dealerSpoke: true, dealerTurnsAfterOpener: 2, endedBy: "dealer" },
        { callEndStatus: "completed", dealerSpoke: true, answeredBy: "staff_or_family" },
        { callEndStatus: "hung_up", callEndOutcome: "early_hangup", durationSecs: 5, dealerSpoke: true },
        { callEndStatus: "completed", dealerSpoke: true },
    ];

    it.each(samples.map((s) => [mapDispositionV3(s).disposition, s] as const))(
        "%s classifies with the same connect status and bucket",
        (_label, input) => {
            const d = mapDispositionV3(input);
            const c = classifyDisposition(d.disposition);
            expect(c?.isKnown).toBe(true);
            expect(c?.connectStatus).toBe(d.connectStatus);
            expect(c?.bucket).toBe(d.bucket);
        },
    );
});

describe("redialHints", () => {
    it("hung up during intro → shorter opener; wrong person → ask for the owner's mobile", () => {
        expect(redialHints("19")).toEqual({ short_opener: "1", ask_owner_mobile: "0", last_disposition_rule: "19" });
        expect(redialHints("18")).toEqual({ short_opener: "0", ask_owner_mobile: "1", last_disposition_rule: "18" });
    });

    it("any other rule, or none, sends both flags off (keys always present)", () => {
        expect(redialHints("2")).toEqual({ short_opener: "0", ask_owner_mobile: "0", last_disposition_rule: "2" });
        expect(redialHints(null)).toEqual({ short_opener: "0", ask_owner_mobile: "0", last_disposition_rule: "" });
    });
});
