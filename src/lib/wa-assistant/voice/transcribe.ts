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
    /** One attempt. Gemini sometimes sits on a request for 30-50 s and then answers a retry in 2 s. */
    attemptTimeoutMs?: number;
    /** Cancels the call (the other transcriber already answered). */
    signal?: AbortSignal;
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
    const deadline = Date.now() + (o.deadlineMs ?? 40_000);
    const attemptMs = o.attemptTimeoutMs ?? 12_000;

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
        if (o.signal?.aborted) return { kind: "failed", error: "cancelled" };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.min(remaining, attemptMs));
        o.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
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
            lastError = ctrl.signal.aborted ? "gemini_timeout" : err instanceof Error ? err.message : String(err);
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

// ── OpenRouter: the paid transcriber ────────────────────────────────────────
//
// The free-tier Gemini key stalls for 30 s to several minutes at a time
// (2026-09-28: four notes lost in one morning, and a replay of the same notes
// stalled again), and a stall outlasts any retry budget. Paid traffic through
// OpenRouter does not sit in that queue, so it goes first; the free key is the
// backup. Same prompt and JSON reply as the direct Gemini call.

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** OpenRouter's input_audio formats, keyed by our normalised mime. */
const OPENROUTER_FORMAT: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/flac": "flac",
    "audio/aiff": "aiff",
};

type OpenRouterOpts = {
    bytes: Buffer;
    mimeType: string | null;
    apiKey: string | null;
    model: string;
    vocab?: VoiceVocab;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    deadlineMs?: number;
    attemptTimeoutMs?: number;
    signal?: AbortSignal;
};

export async function transcribeWithOpenRouter(o: OpenRouterOpts): Promise<TranscribeOutcome> {
    if (!o.apiKey) return { kind: "failed", error: "OPENROUTER_API_KEY is not set" };
    if (o.bytes.length === 0) return { kind: "no_speech" };
    if (o.bytes.length > MAX_VOICE_BYTES) return { kind: "too_long" };
    const mime = normalizeAudioMime(o.mimeType) ?? "audio/ogg";
    const format = OPENROUTER_FORMAT[mime];
    if (!format) return { kind: "unsupported", mimeType: mime };

    const fetchImpl = o.fetchImpl ?? fetch;
    const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (o.deadlineMs ?? 35_000);
    const attemptMs = o.attemptTimeoutMs ?? 15_000;

    const body = JSON.stringify({
        model: o.model,
        temperature: 0,
        max_tokens: 2048,
        // Transcription needs no deliberation (same as the direct call's thinkingLevel low).
        reasoning: { effort: "low", exclude: true },
        messages: [
            {
                role: "user",
                content: [
                    { type: "input_audio", input_audio: { data: o.bytes.toString("base64"), format } },
                    { type: "text", text: buildTranscriptionPrompt(o.vocab ?? EMPTY_VOCAB) },
                ],
            },
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "transcript",
                strict: true,
                schema: {
                    type: "object",
                    properties: { transcript: { type: "string" }, has_speech: { type: "boolean" } },
                    required: ["transcript", "has_speech"],
                    additionalProperties: false,
                },
            },
        },
    });

    let lastError = "not attempted";
    for (let attempt = 1; attempt <= 2; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        if (o.signal?.aborted) return { kind: "failed", error: "cancelled" };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.min(remaining, attemptMs));
        o.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
        try {
            const res = await fetchImpl(OPENROUTER_CHAT_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${o.apiKey}`,
                    "X-Title": "iTarang WhatsApp Assistant",
                },
                body,
                signal: ctrl.signal,
            });
            const data = (await res.json().catch(() => null)) as {
                error?: { message?: string };
                choices?: { message?: { content?: string | null } }[];
            } | null;
            if (!res.ok || data?.error) {
                lastError = data?.error?.message ?? `openrouter_http_${res.status}`;
                if ((res.status === 429 || res.status >= 500 || res.ok) && attempt < 2) {
                    await sleep(500);
                    continue;
                }
                return { kind: "failed", error: lastError };
            }
            const text = data?.choices?.[0]?.message?.content ?? "";
            const parsed = parseModelJson(text);
            if (!parsed) return { kind: "failed", error: text ? "openrouter_unparseable_json" : "openrouter_empty_response" };
            const transcript = cleanTranscript(parsed.transcript);
            if (!parsed.has_speech || isEmptyTranscript(transcript)) return { kind: "no_speech" };
            return { kind: "ok", text: transcript };
        } catch (err) {
            lastError = ctrl.signal.aborted ? "openrouter_timeout" : err instanceof Error ? err.message : String(err);
            if (attempt < 2 && Date.now() < deadline) await sleep(500);
        } finally {
            clearTimeout(timer);
        }
    }
    return { kind: "failed", error: lastError };
}

// ── Hedging: primary first, backup when the primary is slow or fails ───────

export type Transcriber = (signal: AbortSignal) => Promise<TranscribeOutcome>;

/** Gemini answers a normal note in ~2 s; past this it is probably stalled. */
export const HEDGE_AFTER_MS = 5_000;

/**
 * Starts `primary`; starts `backup` as soon as the primary fails or has not
 * answered within `hedgeAfterMs`. The first definite answer wins (anything but
 * `failed`) and the other call is cancelled. Only when BOTH fail is the note
 * lost, and the error names both causes. Never throws.
 */
export function hedgeTranscription(
    primary: Transcriber,
    backup: Transcriber | null,
    hedgeAfterMs: number = HEDGE_AFTER_MS,
): Promise<{ outcome: TranscribeOutcome; via: "primary" | "backup" }> {
    const primaryCtrl = new AbortController();
    const backupCtrl = new AbortController();
    const safe = (t: Transcriber, signal: AbortSignal): Promise<TranscribeOutcome> =>
        t(signal).catch((err: unknown) => ({ kind: "failed", error: err instanceof Error ? err.message : String(err) }));

    return new Promise((resolve) => {
        let done = false;
        let backupStarted = false;
        let running = 1;
        const errors: string[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;

        const settle = (outcome: TranscribeOutcome, via: "primary" | "backup") => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            primaryCtrl.abort();
            backupCtrl.abort();
            resolve({ outcome, via });
        };
        const handle = (outcome: TranscribeOutcome, via: "primary" | "backup") => {
            if (done) return;
            if (outcome.kind !== "failed") return settle(outcome, via);
            errors.push(`${via}: ${outcome.error}`);
            if (via === "primary") startBackup();
            running--;
            if (running === 0) settle({ kind: "failed", error: errors.join("; ") }, via);
        };
        const startBackup = () => {
            if (backupStarted || done || !backup) return;
            backupStarted = true;
            running++;
            void safe(backup, backupCtrl.signal).then((o) => handle(o, "backup"));
        };

        if (backup) timer = setTimeout(startBackup, hedgeAfterMs);
        void safe(primary, primaryCtrl.signal).then((o) => handle(o, "primary"));
    });
}
