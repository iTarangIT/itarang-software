// Voice-note accuracy harness for the WhatsApp Sales Assistant.
//
// Runs the REAL transcriber (src/lib/wa-assistant/voice/transcribe.ts, same
// prompt, same model) over a folder of recorded voice notes and scores each
// transcript against what was actually said. Read-only: no DB, no WhatsApp.
//
//   node --import tsx --env-file=.env.local scripts/verify-wa-voice.ts <dir> [paceMs]
//
// paceMs (default 13000) spaces the calls out: the free-tier Gemini key allows
// 5 requests a minute, shared with the live assistant.
//
// <dir> holds the audio files (.ogg/.opus from WhatsApp, .mp3, .m4a, .wav) and
// an expected.json:
//
//   {
//     "names": ["Sharma Battery House", "Ramesh Traders"],   // optional spelling hints
//     "samples": { "01-follow-up.ogg": "Sharma Battery House ka follow-up kal 11 baje set karo" }
//   }
//
// Per sample it prints the transcript, the word error rate (case/punctuation
// insensitive) and whether every digit run (phone numbers, ₹, quantities)
// came through exactly — the part a wrong guess would make expensive.

import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { assistantConfig } from "@/lib/assistant/config";
import { voiceConfig } from "@/lib/wa-assistant/voice/config";
import { transcribeVoice } from "@/lib/wa-assistant/voice/transcribe";

const MIME: Record<string, string> = {
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
};

const words = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}.]+/gu, " ")
        .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
        .split(/\s+/)
        .filter(Boolean);

/** Word-level Levenshtein distance / reference length. */
export function wer(ref: string, hyp: string): number {
    const r = words(ref);
    const h = words(hyp);
    if (r.length === 0) return h.length ? 1 : 0;
    const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
    for (let j = 1; j <= h.length; j++) d[0][j] = j;
    for (let i = 1; i <= r.length; i++) {
        for (let j = 1; j <= h.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
        }
    }
    return d[r.length][h.length] / r.length;
}

const digitRuns = (s: string) => (s.replace(/[\s,]/g, "").match(/\d+(\.\d+)?/g) ?? []).join("|");

async function main() {
    const dir = process.argv[2];
    const paceMs = Number(process.argv[3] ?? 13_000);
    if (!dir) {
        console.error("usage: scripts/verify-wa-voice.ts <dir with audio + expected.json>");
        process.exit(2);
    }
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as {
        names?: string[];
        products?: string[];
        samples: Record<string, string>;
    };
    const cfg = assistantConfig();
    const model = voiceConfig().model;
    if (!cfg.apiKey) throw new Error("WA_ASSIST_GEMINI_API_KEY is not set");
    console.log(`model ${model} · ${Object.keys(expected.samples).length} samples\n`);

    const files = new Set(readdirSync(dir));
    let totalWer = 0;
    let digitsOk = 0;
    let n = 0;
    for (const [file, ref] of Object.entries(expected.samples)) {
        if (!files.has(file)) {
            console.log(`✗ ${file}: missing`);
            continue;
        }
        if (n > 0 && paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
        const started = Date.now();
        const r = await transcribeVoice({
            bytes: readFileSync(join(dir, file)),
            mimeType: MIME[extname(file).toLowerCase()] ?? null,
            apiKey: cfg.apiKey,
            model,
            vocab: { names: expected.names ?? [], products: expected.products ?? [] },
        });
        const ms = Date.now() - started;
        n++;
        if (r.kind !== "ok") {
            totalWer += 1;
            console.log(`✗ ${file} (${ms} ms): ${r.kind}${"error" in r ? ` — ${r.error}` : ""}`);
            continue;
        }
        const w = wer(ref, r.text);
        const dOk = digitRuns(ref) === digitRuns(r.text);
        totalWer += w;
        if (dOk) digitsOk++;
        console.log(`${w <= 0.1 && dOk ? "✓" : "✗"} ${file} (${ms} ms)  WER ${(w * 100).toFixed(0)}%  digits ${dOk ? "exact" : "WRONG"}`);
        console.log(`    said:  ${ref}`);
        console.log(`    heard: ${r.text}`);
    }
    if (n) {
        console.log(`\nmean WER ${((totalWer / n) * 100).toFixed(1)}% · digits exact ${digitsOk}/${n}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
