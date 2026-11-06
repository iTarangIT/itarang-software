import { describe, expect, it } from "vitest";
import { asDurationSec, parseInboundEvent } from "../mapper";

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
