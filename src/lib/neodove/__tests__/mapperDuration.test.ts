import { describe, expect, it } from "vitest";
import { asDurationSec, parseInboundEvent, unwrapRecordingList } from "../mapper";

describe("ID 224: NeoDove call duration and recording", () => {
    it("reads seconds, mm:ss and hh:mm:ss", () => {
        expect(asDurationSec("95")).toBe(95);
        expect(asDurationSec(42)).toBe(42);
        expect(asDurationSec("01:35")).toBe(95);
        expect(asDurationSec("1:02:03")).toBe(3723);
        expect(asDurationSec("NA")).toBeNull();
        expect(asDurationSec("")).toBeNull();
    });

    it("finds duration and recording under a nested call object", () => {
        const e = parseInboundEvent({
            event_name: "LEAD_DISPOSE",
            mobile: "9876543210",
            time: "1762400000000",
            call: { talk_time: "02:10", call_recording_url: "https://rec.example.com/a.mp3" },
        });
        expect(e.callDurationSec).toBe(130);
        expect(e.recordingUrl).toBe("https://rec.example.com/a.mp3");
    });

    it("leaves both empty for today's disposition webhook (it sends neither)", () => {
        const e = parseInboundEvent({ event_name: "LEAD_DISPOSE", mobile: "9876543210", call_connected: "true" });
        expect(e.callDurationSec).toBeNull();
        expect(e.recordingUrl).toBeNull();
    });
});


describe("ID 224 (17 Nov): NeoDove's recording list", () => {
    // The shape live received on 10 Nov (link shortened).
    const body = {
        time: " ",
        mobile: "9891840000",
        lead_id: 855760774,
        agent_name: "Chirag Garg",
        event_name: "CALL_RECORDING",
        campaign_id: "7d255b90-690c-428e-8f82-86205672a8fd",
        recording_url: [{ recording_url: "https://rec.example.com/a.mp3", call_duration_in_sec: 90 }],
    };

    it("reads the link and the duration out of the list", () => {
        const e = parseInboundEvent(body);
        expect(e.recordingUrl).toBe("https://rec.example.com/a.mp3");
        expect(e.callDurationSec).toBe(90);
    });

    it("takes the last entry with a link; a JSON string list works too", () => {
        const two = [
            { recording_url: "https://rec.example.com/1.mp3", call_duration_in_sec: 10 },
            { recording_url: "https://rec.example.com/2.mp3", call_duration_in_sec: 20 },
        ];
        expect(unwrapRecordingList(two)).toEqual({ url: "https://rec.example.com/2.mp3", durationSec: 20 });
        expect(parseInboundEvent({ ...body, recording_url: JSON.stringify(two) }).callDurationSec).toBe(20);
    });

    it("a plain link still works; an empty list or a non-link gives no recording", () => {
        expect(parseInboundEvent({ ...body, recording_url: "https://rec.example.com/b.mp3" }).recordingUrl).toBe(
            "https://rec.example.com/b.mp3",
        );
        expect(unwrapRecordingList("https://x")).toBeNull();
        expect(parseInboundEvent({ ...body, recording_url: [] }).recordingUrl).toBeNull();
        expect(parseInboundEvent({ ...body, recording_url: [{ call_duration_in_sec: 5 }] }).recordingUrl).toBeNull();
        expect(parseInboundEvent({ ...body, recording_url: ["not a link"] }).recordingUrl).toBeNull();
    });
});

describe("ID 224 (17 Nov): 'Call Connected' sends an empty link but the duration", () => {
    it("keeps the duration when the link is empty (the shape all 21 live events had)", () => {
        const e = parseInboundEvent({
            event_name: "CALL_RECORDING",
            mobile: "9891840000",
            recording_url: [{ recording_url: "", call_duration_in_sec: 179 }],
        });
        expect(e.recordingUrl).toBeNull();
        expect(e.callDurationSec).toBe(179);
    });

    it("a later entry with a link wins over an earlier duration-only one", () => {
        expect(
            unwrapRecordingList([
                { recording_url: "https://rec.example.com/x.mp3", call_duration_in_sec: 30 },
                { recording_url: "", call_duration_in_sec: 31 },
            ]),
        ).toEqual({ url: "https://rec.example.com/x.mp3", durationSec: 30 });
        expect(unwrapRecordingList([])).toEqual({ url: null, durationSec: null });
    });
});
