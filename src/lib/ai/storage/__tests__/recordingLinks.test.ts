import { describe, expect, it } from "vitest";

import {
    callRecordingLink,
    callRecordingPlayPath,
    isCheckedPlayPath,
    isOwnRecordingUrl,
    touchpointRecordingLink,
    touchpointRecordingPlayPath,
} from "../recordingLinks";

const OWN_PROXY = "/api/files/call-recordings/bolna/abc.mp3";
const OWN_ABSOLUTE = "https://crm.itarang.com/api/files/call-recordings/neodove/tp.mp3";
const OWN_SUPABASE = "https://x.supabase.co/storage/v1/object/public/call-recordings/bolna/abc.mp3";
const BOLNA = "https://bolna-recordings.s3.amazonaws.com/abc.mp3";
const NEODOVE = "https://neodove-prod.s3.ap-south-1.amazonaws.com/rec/123.mp3";
const TP = "0b1f6a3e-2c1d-4e5f-8a9b-0c1d2e3f4a5b";

describe("recording links (ID 166, 18 Oct item 7)", () => {
    it("knows our own storage, relative, absolute and Supabase", () => {
        expect(isOwnRecordingUrl(OWN_PROXY)).toBe(true);
        expect(isOwnRecordingUrl(OWN_ABSOLUTE)).toBe(true);
        expect(isOwnRecordingUrl(OWN_SUPABASE)).toBe(true);
        expect(isOwnRecordingUrl(BOLNA)).toBe(false);
        expect(isOwnRecordingUrl(null)).toBe(false);
    });

    it("an AI call: our copy as stored, a provider link never — the checked play route instead", () => {
        expect(callRecordingLink("c1", OWN_PROXY)).toBe(OWN_PROXY);
        expect(callRecordingLink("c1", BOLNA)).toBe(callRecordingPlayPath("c1"));
        expect(callRecordingLink("c 1/x", null)).toBe("/api/ai-dialer/recording/c%201%2Fx");
        expect(callRecordingLink(null, BOLNA)).toBeNull();
        expect(callRecordingLink(null, null)).toBeNull();
    });

    it("a touchpoint: provider link → checked touchpoint route; no stored link → no recording", () => {
        expect(touchpointRecordingLink(TP, NEODOVE)).toBe(touchpointRecordingPlayPath(TP));
        expect(touchpointRecordingLink(TP, OWN_ABSOLUTE)).toBe(OWN_ABSOLUTE);
        expect(touchpointRecordingLink(TP, null)).toBeNull();
        expect(touchpointRecordingLink(TP, "  ")).toBeNull();
        expect(touchpointRecordingLink(null, NEODOVE)).toBeNull();
    });

    it("is idempotent: a play route passes through unchanged", () => {
        const call = callRecordingPlayPath("c1");
        const tp = touchpointRecordingPlayPath(TP);
        expect(isCheckedPlayPath(call)).toBe(true);
        expect(isCheckedPlayPath(tp)).toBe(true);
        expect(callRecordingLink("other", call)).toBe(call);
        expect(touchpointRecordingLink(TP, touchpointRecordingLink(TP, NEODOVE))).toBe(tp);
        expect(isCheckedPlayPath("https://evil.example/api/ai-dialer/recording/c1")).toBe(false);
    });

    it("no provider host ever comes out of either helper", () => {
        for (const out of [callRecordingLink("c1", BOLNA), touchpointRecordingLink(TP, NEODOVE)]) {
            expect(out).not.toMatch(/amazonaws|bolna|neodove/i);
        }
    });
});
