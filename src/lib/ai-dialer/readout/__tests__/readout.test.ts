import { describe, expect, it } from "vitest";
import {
    callDefects,
    introRestarts,
    isCompleteConversation,
    readoutLines,
    readoutRow,
    readoutTurnsFromProvider,
    type ReadoutDial,
} from "../readout";

const dial = (extra: Partial<ReadoutDial>): ReadoutDial => ({
    direction: "outbound",
    l1: "Connected",
    l2: "Cold",
    l3: "Need Some Time",
    rule: "20",
    durationSecs: 40,
    ...extra,
});
const nc = (l2: string, rule = "2") => dial({ l1: "Not Connected", l2, l3: null, rule, durationSecs: 0 });
const machine = (l3: string) => dial({ l2: "Machine", l3, rule: "8", durationSecs: 20 });

describe("isCompleteConversation", () => {
    it.each(["Information Collected", "Ask to Call Back", "Not Interested", "REJECTED BY US", "Some other Business"])(
        "%s counts",
        (l3) => {
            expect(isCompleteConversation(dial({ l3, l2: l3 === "Information Collected" ? "Warm" : "Cold" }))).toBe(true);
        },
    );

    it.each(["Hung up during intro", "Dropped mid-call", "Need Some Time", "Wrong person (staff / family)", "Language mismatch"])(
        "%s does not (a hang-up, a lag or a confusion)",
        (l3) => {
            expect(isCompleteConversation(dial({ l3 }))).toBe(false);
        },
    );

    it("a machine or a not-connected dial never counts", () => {
        expect(isCompleteConversation(machine("Recording / voicemail"))).toBe(false);
        expect(isCompleteConversation(nc("Did not pick"))).toBe(false);
    });
});

describe("readoutRow", () => {
    it("reproduces the tracker's 4 Nov row: 46 dials, 16 humans, 6 complete, 13.0 per 100, 44% gone in 15 s", () => {
        const dials: ReadoutDial[] = [
            ...Array.from({ length: 22 }, () => nc("Did not pick")),
            ...Array.from({ length: 8 }, () => machine("IVR / auto-attendant")),
            dial({ l2: "Warm", l3: "Information Collected", rule: "12" }),
            dial({ l2: "Warm", l3: "Information Collected", rule: "12" }),
            dial({ l2: "Lost", l3: "Not Interested", rule: "14" }),
            dial({ l2: "Lost", l3: "Not Interested", rule: "14" }),
            dial({ l2: "Lost", l3: "REJECTED BY US", rule: "13" }),
            dial({ l3: "Ask to Call Back", rule: "15" }),
            ...Array.from({ length: 7 }, () => dial({ l3: "Hung up during intro", rule: "19", durationSecs: 8 })),
            ...Array.from({ length: 3 }, () => dial({ l3: "Dropped mid-call", rule: "17", durationSecs: 35 })),
        ];
        const r = readoutRow({ day: "2026-11-04", dials, inbound: { total: 0, answered: 0 } });
        expect(r).toMatchObject({ dials: 46, humans: 16, complete: 6, per100: 13, gone15Pct: 44 });
    });

    it("rule 7 (a person picked up and said 'wrong number') is a human, never a complete conversation", () => {
        const r = readoutRow({ day: "d", dials: [dial({ l1: "Not Connected", l2: "Incorrect / Invalid number", l3: null, rule: "7" })], inbound: { total: 0, answered: 0 } });
        expect(r).toMatchObject({ dials: 1, humans: 1, complete: 0 });
    });

    it("a day with no dials: no divide by zero", () => {
        const r = readoutRow({ day: "d", dials: [], inbound: { total: 3, answered: 1 } });
        expect(r).toMatchObject({ dials: 0, humans: 0, complete: 0, per100: null, gone15Pct: null, inboundTotal: 3, inboundAnswered: 1 });
    });

    it("dials but no humans: per 100 is 0, gone-in-15 is null", () => {
        const r = readoutRow({ day: "d", dials: [nc("Busy in another call", "1"), machine("Dead audio (no sound either way)")], inbound: { total: 0, answered: 0 } });
        expect(r).toMatchObject({ dials: 2, humans: 0, per100: 0, gone15Pct: null });
    });

    it("inbound conversations are not dials", () => {
        const r = readoutRow({
            day: "d",
            dials: [dial({ direction: "inbound", l2: "Warm", l3: "Information Collected", rule: "12" })],
            inbound: { total: 1, answered: 1 },
        });
        expect(r).toMatchObject({ dials: 0, complete: 0, inboundAnswered: 1 });
    });

    it("a human with no known duration is not counted as gone in 15 s", () => {
        const r = readoutRow({ day: "d", dials: [dial({ durationSecs: null })], inbound: { total: 0, answered: 0 } });
        expect(r.gone15Pct).toBe(0);
    });
});

describe("defect flags", () => {
    const opener = "नमस्ते sir, मैं Priya बोल रही हूँ iTarang Technologies से। हम Trontek lithium batteries में deal करते हैं";

    it("an intro restarted twice is counted twice; a normal reply is not a restart", () => {
        const turns = [
            { role: "agent", message: opener },
            { role: "user", message: "hello?" },
            { role: "agent", message: opener },
            { role: "user", message: "haan" },
            { role: "agent", message: "नमस्ते sir, मैं Priya बोल रही हूँ iTarang Technologies से।" },
            { role: "user", message: "haan boliye" },
            { role: "agent", message: "आप कौन सी battery का काम करते हैं?" },
        ];
        expect(introRestarts(turns)).toBe(2);
    });

    it("a short opener or a single agent turn cannot be restarted", () => {
        expect(introRestarts([{ role: "agent", message: "Hello" }, { role: "agent", message: "Hello" }])).toBe(0);
        expect(introRestarts([{ role: "agent", message: opener }])).toBe(0);
        expect(introRestarts([])).toBe(0);
    });

    it("slow replies use the provider's since-silence latency, and the opener is skipped", () => {
        const turns = readoutTurnsFromProvider([
            { role: "agent", message: opener, conversation_turn_metrics: { metrics: { convai_ttf_audio_since_silence: { elapsed_time: 9 } } } },
            { role: "user", message: "haan" },
            { role: "agent", message: "a", conversation_turn_metrics: { metrics: { convai_ttf_audio_since_silence: { elapsed_time: 2.48 } } } },
            { role: "user", message: "ji" },
            { role: "agent", message: "b", conversation_turn_metrics: { metrics: { convai_ttf_audio_since_silence: { elapsed_time: 1.07 } } } },
            { role: "user", message: "ok" },
            { role: "agent", message: "c" },
        ]);
        const f = callDefects(dial({ turns }));
        expect(f.slowReplies).toBe(1);
        expect(f.agentReplies).toBe(2);
    });

    it("gone in 15 s: a human under 15 s; 15 s exactly is not", () => {
        expect(callDefects(dial({ durationSecs: 14.9 })).goneIn15).toBe(true);
        expect(callDefects(dial({ durationSecs: 15 })).goneIn15).toBe(false);
        expect(callDefects(machine("Dead audio (no sound either way)")).goneIn15).toBe(false);
    });

    it("a flip to English on a Hindi dealer is flagged", () => {
        const transcript = `agent: ${opener}\nuser: Hello.\nagent: Hello sir, I am calling about lithium batteries for your shop.`;
        expect(callDefects(dial({ transcript, callLanguage: "hi" })).languageFlip).toBe(true);
    });

    it("readoutTurnsFromProvider tolerates junk", () => {
        expect(readoutTurnsFromProvider(null)).toBeNull();
        expect(readoutTurnsFromProvider([])).toBeNull();
        expect(readoutTurnsFromProvider([null, { role: "user" }])).toEqual([{ role: "user", message: "", replySecs: null }]);
    });
});

describe("readoutLines", () => {
    it("prints the version, one line per day and today's defects", () => {
        const row = readoutRow({ day: "2026-11-05", dials: [dial({ l2: "Warm", l3: "Information Collected", rule: "12" })], inbound: { total: 2, answered: 1 } });
        const lines = readoutLines([row], { version: "v27", changeTested: "v27 opener" });
        expect(lines[0]).toBe("Version: v27 · Change tested: v27 opener");
        expect(lines.some((l) => l.startsWith("2026-11-05") && l.includes("100.0") && l.includes("1 of 2"))).toBe(true);
        expect(lines.some((l) => l.startsWith("Today's defects"))).toBe(true);
    });
});
