import { describe, expect, it, vi } from "vitest";
import { buildTranscriptionPrompt, cleanTerm, staticVocab, VOCAB_LIMITS } from "../voice/prompt";
import { cleanTranscript, MAX_VOICE_BYTES, normalizeAudioMime, transcribeVoice } from "../voice/transcribe";

const AUDIO = Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);

type GeminiBody = {
    contents: { parts: { inline_data?: unknown; text?: string }[] }[];
    generationConfig: Record<string, unknown> & { thinkingConfig?: unknown };
};

function gemini(steps: ({ status: number; body: unknown } | Error)[]) {
    const calls: { url: string; headers: Headers; body: GeminiBody }[] = [];
    let i = 0;
    const fn = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        const s = steps[Math.min(i++, steps.length - 1)];
        if (s instanceof Error) throw s;
        return new Response(JSON.stringify(s.body), { status: s.status });
    });
    return { fn: fn as unknown as typeof fetch, calls, raw: fn };
}
const answer = (obj: unknown) => ({
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] },
});
const base = { bytes: AUDIO, mimeType: "audio/ogg; codecs=opus", apiKey: "k-test", model: "gemini-3.6-flash", sleep: async () => {} };

describe("voice prompt", () => {
    it("asks for a verbatim Roman-script transcript with numbers as digits, as JSON", () => {
        const p = buildTranscriptionPrompt();
        expect(p).toMatch(/Verbatim/);
        expect(p).toMatch(/NEVER use Devanagari/);
        expect(p).toMatch(/9876543210/);
        expect(p).toMatch(/25000/);
        expect(p).toMatch(/"has_speech"/);
    });

    it("carries the existing Hinglish aliases and call labels, not new vocabulary", () => {
        const v = staticVocab();
        expect(v).toEqual(expect.arrayContaining(["nahi uthaya", "rate zyada hai", "dealer nahi mila", "Did not pick", "Switch off"]));
        expect(new Set(v.map((t) => t.toLowerCase())).size).toBe(v.length);
    });

    it("adds the rep's own names and products — cleaned, deduped and capped", () => {
        const names = ["Sharma Battery House", "sharma battery house", 'Ram"esh\nTraders', "Pune", ...Array.from({ length: 200 }, (_, i) => `Dealer ${i}`)];
        const p = buildTranscriptionPrompt({ names, products: ["LFP 51.2V 105Ah"] });
        expect(p).toContain("Sharma Battery House; Ram esh Traders; Pune");
        expect(p).toContain("Product names: LFP 51.2V 105Ah.");
        const line = p.split("\n").find((l) => l.startsWith("Dealer, shop and city names"))!;
        expect(line.split("; ").length).toBe(VOCAB_LIMITS.names);
        expect(cleanTerm("x".repeat(500)).length).toBe(VOCAB_LIMITS.chars);
    });

    it("no names → no names line", () => {
        expect(buildTranscriptionPrompt()).not.toContain("in this rep's queue");
    });
});

describe("normalizeAudioMime / cleanTranscript", () => {
    it("strips codec params and maps aliases", () => {
        expect(normalizeAudioMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
        expect(normalizeAudioMime("audio/MP3")).toBe("audio/mpeg");
        expect(normalizeAudioMime("audio/x-m4a")).toBe("audio/mp4");
        expect(normalizeAudioMime(null)).toBeNull();
    });

    it("collapses whitespace and caps at the agent's input limit", () => {
        expect(cleanTranscript("  kal   11 baje\n follow-up ")).toBe("kal 11 baje follow-up");
        expect(cleanTranscript("a".repeat(5000)).length).toBe(2000);
    });
});

describe("transcribeVoice", () => {
    it("sends the audio inline with the prompt, the key in a header, temperature 0, JSON schema", async () => {
        const g = gemini([answer({ transcript: "Sharma Battery House ka follow-up kal 11 baje", has_speech: true })]);
        const r = await transcribeVoice({ ...base, fetchImpl: g.fn, vocab: { names: ["Sharma Battery House"], products: [] } });
        expect(r).toEqual({ kind: "ok", text: "Sharma Battery House ka follow-up kal 11 baje" });
        const c = g.calls[0];
        expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
        expect(c.url).not.toContain("k-test");
        expect(c.headers.get("x-goog-api-key")).toBe("k-test");
        const parts = c.body.contents[0].parts;
        expect(parts[0].inline_data).toEqual({ mime_type: "audio/ogg", data: AUDIO.toString("base64") });
        expect(parts[1].text).toContain("Sharma Battery House");
        expect(c.body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: "application/json" });
        expect(c.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    });

    it("no thinkingConfig for a non-Gemini-3 model", async () => {
        const g = gemini([answer({ transcript: "hi", has_speech: true })]);
        await transcribeVoice({ ...base, model: "gemini-2.5-flash", fetchImpl: g.fn });
        expect(g.calls[0].body.generationConfig.thinkingConfig).toBeUndefined();
    });

    it("silence, an empty transcript or only [unclear] → no_speech", async () => {
        for (const obj of [
            { transcript: "", has_speech: true },
            { transcript: "anything", has_speech: false },
            { transcript: "[unclear] [unclear].", has_speech: true },
        ]) {
            const g = gemini([answer(obj)]);
            expect(await transcribeVoice({ ...base, fetchImpl: g.fn })).toEqual({ kind: "no_speech" });
        }
    });

    it("tolerates a fenced JSON reply and ignores thought parts", async () => {
        const g = gemini([{
            status: 200,
            body: { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: '```json\n{"transcript":"my queue dikhao","has_speech":true}\n```' }] } }] },
        }]);
        expect(await transcribeVoice({ ...base, fetchImpl: g.fn })).toEqual({ kind: "ok", text: "my queue dikhao" });
    });

    it("malformed model output → failed, never a guess", async () => {
        const g = gemini([{ status: 200, body: { candidates: [{ content: { parts: [{ text: "Sure! The rep said…" }] } }] } }]);
        expect(await transcribeVoice({ ...base, fetchImpl: g.fn })).toEqual({ kind: "failed", error: "gemini_unparseable_json" });
    });

    it("retries 429 / 5xx / network, not 400", async () => {
        const g = gemini([{ status: 429, body: { error: { message: "quota" } } }, new Error("fetch failed"), answer({ transcript: "ok", has_speech: true })]);
        expect(await transcribeVoice({ ...base, fetchImpl: g.fn })).toEqual({ kind: "ok", text: "ok" });
        expect(g.raw).toHaveBeenCalledTimes(3);

        const b = gemini([{ status: 400, body: { error: { message: "bad audio" } } }]);
        expect(await transcribeVoice({ ...base, fetchImpl: b.fn })).toEqual({ kind: "failed", error: "bad audio" });
        expect(b.raw).toHaveBeenCalledTimes(1);

        const q = gemini([{ status: 429, body: { error: { message: "quota" } } }]);
        expect(await transcribeVoice({ ...base, fetchImpl: q.fn })).toEqual({ kind: "failed", error: "quota" });
        expect(q.raw).toHaveBeenCalledTimes(3);
    });

    it("no key / too big / AMR are refused without a call", async () => {
        const g = gemini([answer({ transcript: "x", has_speech: true })]);
        expect(await transcribeVoice({ ...base, apiKey: null, fetchImpl: g.fn })).toMatchObject({ kind: "failed" });
        expect(await transcribeVoice({ ...base, bytes: Buffer.alloc(MAX_VOICE_BYTES + 1), fetchImpl: g.fn })).toEqual({ kind: "too_long" });
        expect(await transcribeVoice({ ...base, mimeType: "audio/amr", fetchImpl: g.fn })).toEqual({ kind: "unsupported", mimeType: "audio/amr" });
        expect(g.raw).not.toHaveBeenCalled();
    });
});
