// Voice note → text with Gemini (inline audio, generateContent REST).
//
// Pure HTTP with an injectable fetch, so it is unit-tested without a network.
// Never throws: every failure is a `failed` outcome the router answers with a
// fixed "please send it again or type it" — nothing is written either way.
//
// The inline-media call follows src/lib/whatsapp/extraction.ts generate() (same
// retry rules: 429 / 5xx / network only), re-written here because the Assistant
// may not import the dealer bot's code (isolation.contract.test.ts).

import { buildTranscriptionPrompt, EMPTY_VOCAB, type VoiceVocab } from "./prompt";

export const GENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** ~3 minutes of WhatsApp's opus voice note; also Gemini's comfortable inline size. */
export const MAX_VOICE_BYTES = 3 * 1024 * 1024;

/** The agent's own input cap (agent.ts): a longer transcript would be cut there anyway. */
export const MAX_TRANSCRIPT_CHARS = 2000;

export type TranscribeOutcome =
    | { kind: "ok"; text: string }
    | { kind: "no_speech" }
    | { kind: "too_long" }
    | { kind: "unsupported"; mimeType: string }
    | { kind: "failed"; error: string };

type Opts = {
    bytes: Buffer;
    mimeType: string | null;
    apiKey: string | null;
    model: string;
    vocab?: VoiceVocab;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    /** Whole call, retries included. */
    deadlineMs?: number;
};

const MAX_ATTEMPTS = 3;

/** WhatsApp sends "audio/ogg; codecs=opus" — Gemini wants the bare type. */
export function normalizeAudioMime(mime: string | null | undefined): string | null {
    const base = (mime ?? "").split(";")[0].trim().toLowerCase();
    if (!base) return null;
    const alias: Record<string, string> = {
        "audio/opus": "audio/ogg",
        "audio/mp3": "audio/mpeg",
        "audio/x-m4a": "audio/mp4",
        "audio/m4a": "audio/mp4",
        "audio/x-wav": "audio/wav",
        "audio/wave": "audio/wav",
    };
    return alias[base] ?? base;
}

/** What Gemini accepts inline. WhatsApp's audio/amr is the one it does not. */
const SUPPORTED = new Set(["audio/ogg", "audio/mpeg", "audio/aac", "audio/mp4", "audio/wav", "audio/flac", "audio/aiff"]);

/** A transcript as the agent should see it: one tidy string, capped. */
export function cleanTranscript(raw: string): string {
    const t = raw.replace(/\s+/g, " ").trim();
    return [...t].slice(0, MAX_TRANSCRIPT_CHARS).join("");
}

/** Nothing but "[unclear]" markers and punctuation is not a message. */
function isEmptyTranscript(t: string): boolean {
    return t.replace(/\[unclear\]/gi, "").replace(/[\s.,!?…\-]+/g, "") === "";
}

function parseModelJson(raw: string): { transcript: string; has_speech: boolean } | null {
    const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
        const j = JSON.parse(body) as { transcript?: unknown; has_speech?: unknown };
        if (typeof j.transcript !== "string") return null;
        return { transcript: j.transcript, has_speech: j.has_speech !== false };
    } catch {
        return null;
    }
}

export async function transcribeVoice(o: Opts): Promise<TranscribeOutcome> {
    if (!o.apiKey) return { kind: "failed", error: "WA_ASSIST_GEMINI_API_KEY is not set" };
    if (o.bytes.length === 0) return { kind: "no_speech" };
    if (o.bytes.length > MAX_VOICE_BYTES) return { kind: "too_long" };
    const mime = normalizeAudioMime(o.mimeType) ?? "audio/ogg";
    if (!SUPPORTED.has(mime)) return { kind: "unsupported", mimeType: mime };

    const fetchImpl = o.fetchImpl ?? fetch;
    const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (o.deadlineMs ?? 30_000);

    const body = JSON.stringify({
        contents: [
            {
                role: "user",
                parts: [
                    { inline_data: { mime_type: mime, data: o.bytes.toString("base64") } },
                    { text: buildTranscriptionPrompt(o.vocab ?? EMPTY_VOCAB) },
                ],
            },
        ],
        generationConfig: {
            temperature: 0,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: { transcript: { type: "STRING" }, has_speech: { type: "BOOLEAN" } },
                required: ["transcript", "has_speech"],
            },
            // Same setting the agent runs with; transcription needs no deliberation.
            ...(/^gemini-3/i.test(o.model) ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
    });

    let lastError = "not attempted";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), remaining);
        try {
            const res = await fetchImpl(`${GENAI_BASE}/${encodeURIComponent(o.model)}:generateContent`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": o.apiKey },
                body,
                signal: ctrl.signal,
            });
            const data = (await res.json().catch(() => null)) as {
                error?: { message?: string };
                candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
            } | null;
            if (!res.ok) {
                lastError = data?.error?.message ?? `gemini_http_${res.status}`;
                if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
                    await sleep(400 * attempt);
                    continue;
                }
                return { kind: "failed", error: lastError };
            }
            const text = (data?.candidates?.[0]?.content?.parts ?? [])
                .filter((p) => !p.thought && typeof p.text === "string")
                .map((p) => p.text)
                .join("");
            const parsed = parseModelJson(text);
            if (!parsed) return { kind: "failed", error: text ? "gemini_unparseable_json" : "gemini_empty_response" };
            const transcript = cleanTranscript(parsed.transcript);
            if (!parsed.has_speech || isEmptyTranscript(transcript)) return { kind: "no_speech" };
            return { kind: "ok", text: transcript };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt < MAX_ATTEMPTS && Date.now() < deadline) {
                await sleep(400 * attempt);
                continue;
            }
        } finally {
            clearTimeout(timer);
        }
    }
    return { kind: "failed", error: lastError };
}
