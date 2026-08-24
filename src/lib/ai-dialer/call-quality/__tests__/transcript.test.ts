import { describe, expect, it } from "vitest";
import {
    FINGERPRINT_CHARS,
    greetingState,
    openingFingerprint,
    parseTranscriptTurns,
    type TranscriptTurn,
} from "../transcript";

/** The exact shape elevenlabs/{getCallStatus,webhookHandler}.ts produce. */
const join = (...lines: string[]) => lines.join("\n");

describe("parseTranscriptTurns", () => {
    it("splits the one-line-per-turn format the stringifiers emit", () => {
        const turns = parseTranscriptTurns(
            join("agent: नमस्ते sir", "user: हाँ बोलिये", "agent: battery चाहिए?"),
        );
        expect(turns).toEqual<TranscriptTurn[]>([
            { speaker: "agent", text: "नमस्ते sir" },
            { speaker: "user", text: "हाँ बोलिये" },
            { speaker: "agent", text: "battery चाहिए?" },
        ]);
    });

    it("treats a line with no speaker prefix as a continuation of the turn above", () => {
        // A turn's message is only .trim()ed upstream, so an embedded newline
        // reaches us intact. Without this rule it reads as a phantom turn and
        // every downstream turn count is wrong.
        const turns = parseTranscriptTurns(
            join("agent: line one", "line two", "user: reply"),
        );
        expect(turns).toEqual<TranscriptTurn[]>([
            { speaker: "agent", text: "line one\nline two" },
            { speaker: "user", text: "reply" },
        ]);
    });

    it("drops leading unprefixed lines rather than inventing a speaker", () => {
        expect(parseTranscriptTurns(join("stray text", "agent: hello"))).toEqual([
            { speaker: "agent", text: "hello" },
        ]);
    });

    it("keeps a speaker the stringifier passed through verbatim", () => {
        // The stringifiers fall back to the raw lowercased role for anything
        // that is not user/agent, so an unknown speaker is representable.
        expect(parseTranscriptTurns("system: call transferred")).toEqual([
            { speaker: "system", text: "call transferred" },
        ]);
    });

    it("survives an empty, whitespace or null transcript", () => {
        expect(parseTranscriptTurns("")).toEqual([]);
        expect(parseTranscriptTurns("   \n  ")).toEqual([]);
        expect(parseTranscriptTurns(null)).toEqual([]);
        expect(parseTranscriptTurns(undefined)).toEqual([]);
    });

    it("keeps a colon inside the message", () => {
        expect(parseTranscriptTurns("agent: price: 45000 रुपये")).toEqual([
            { speaker: "agent", text: "price: 45000 रुपये" },
        ]);
    });

    it("tolerates a missing space after the colon", () => {
        expect(parseTranscriptTurns("agent:hello")).toEqual([
            { speaker: "agent", text: "hello" },
        ]);
    });

    it("preserves an empty turn body without collapsing the turn", () => {
        const turns = parseTranscriptTurns(join("agent: hi", "user:", "agent: still there?"));
        expect(turns.map((t) => t.speaker)).toEqual(["agent", "user", "agent"]);
    });
});

describe("greetingState", () => {
    const agent = (text: string): TranscriptTurn[] => [{ speaker: "agent", text }];

    it("is absent when nobody spoke", () => {
        expect(greetingState([])).toBe("absent");
    });

    it("is absent when the dealer somehow spoke first", () => {
        expect(greetingState([{ speaker: "user", text: "hello?" }])).toBe("absent");
    });

    it("is complete when the opening sentence reaches terminal punctuation", () => {
        expect(greetingState(agent("नमस्ते sir, दो minute बात कर सकते हैं?"))).toBe("complete");
        expect(greetingState(agent("Hello, this is Priya from iTarang."))).toBe("complete");
        // Devanagari danda is terminal punctuation too.
        expect(greetingState(agent("नमस्ते sir, मैं Priya बोल रही हूँ।"))).toBe("complete");
    });

    it("is cut_off when the opening sentence stops mid-flight", () => {
        expect(greetingState(agent("नमस्ते sir! Priya बोल रही हूँ iTarang..."))).toBe("cut_off");
        expect(greetingState(agent("नमस्ते sir! Priya बोल रही हूँ iTarang…"))).toBe("cut_off");
        expect(greetingState(agent("Hello, this is Priya from iTarang Technologies and we"))).toBe(
            "cut_off",
        );
    });

    it("judges the greeting alone, not the whole call", () => {
        // A call that got cut off LATER still delivered a complete greeting.
        const turns: TranscriptTurn[] = [
            { speaker: "agent", text: "नमस्ते sir, दो minute बात कर सकते हैं?" },
            { speaker: "user", text: "हाँ" },
            { speaker: "agent", text: "तो sir हम lithium battery" },
        ];
        expect(greetingState(turns)).toBe("complete");
    });
});

describe("openingFingerprint", () => {
    it("is null when there is no agent turn to fingerprint", () => {
        expect(openingFingerprint([])).toBeNull();
        expect(openingFingerprint([{ speaker: "user", text: "hello" }])).toBeNull();
    });

    // THE BUG THIS FUNCTION EXISTS TO AVOID. At 60 chars the same 83 transcripts
    // yielded 9 "variants"; at 20, four. The extra five were ONE script
    // truncated at different points — the long key measured where the audio
    // stopped, not which script ran.
    it("gives one script the same key however far it got before cutting out", () => {
        const full = openingFingerprint([
            {
                speaker: "agent",
                text: "नमस्ते sir! Priya बोल रही हूँ iTarang Technologies से। हम Trontek batteries",
            },
        ]);
        const short = openingFingerprint([
            { speaker: "agent", text: "नमस्ते sir! Priya बोल रही हूँ iTarang..." },
        ]);
        const shorter = openingFingerprint([
            { speaker: "agent", text: "नमस्ते sir! Priya बोल रही हूँ..." },
        ]);
        expect(full).toBe(short);
        expect(short).toBe(shorter);
    });

    it("still separates genuinely different scripts", () => {
        const namaste = openingFingerprint([
            { speaker: "agent", text: "नमस्ते sir! Priya बोल रही हूँ iTarang Technologies से।" },
        ]);
        const namaskar = openingFingerprint([
            { speaker: "agent", text: "नमस्कार sir, Priya बोल रही हूँ iTarang Technologies से।" },
        ]);
        expect(namaste).not.toBe(namaskar);
    });

    it("collapses whitespace so re-wrapping does not fork a script", () => {
        expect(
            openingFingerprint([{ speaker: "agent", text: "नमस्ते  sir!\n  Priya  बोल" }]),
        ).toBe(openingFingerprint([{ speaker: "agent", text: "नमस्ते sir! Priya बोल" }]));
    });

    it("never returns more than the configured prefix length", () => {
        const key = openingFingerprint([{ speaker: "agent", text: "क".repeat(500) }]);
        expect(key!.length).toBeLessThanOrEqual(FINGERPRINT_CHARS);
    });

    it("returns null for an agent turn with no words in it", () => {
        expect(openingFingerprint([{ speaker: "agent", text: "   " }])).toBeNull();
    });
});
