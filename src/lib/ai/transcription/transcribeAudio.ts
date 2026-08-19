// Speech-to-text for attached call recordings.
//
// This is the repository's FIRST transcription call. Everything else that has a
// transcript got it pre-transcribed from a voice-agent provider (Bolna,
// ElevenLabs) over a webhook — nothing here has ever turned audio into text.
//
// ── WHY OPENAI AND NOT GOOGLE SPEECH-TO-TEXT ─────────────────────────────────
// Google would arguably diarize Hindi better, but it would be the first
// @google-cloud/* client and the first GOOGLE_APPLICATION_CREDENTIALS secret in
// the tree — new plumbing to provision on sandbox AND production, on a project
// whose only existing Google auth is API-key-in-a-query-string. OPENAI_API_KEY
// is already in every environment and getOpenAI() is already the lazy singleton
// pattern this codebase uses.
//
// ── WHY gpt-4o-transcribe AND WHAT IT COSTS US ───────────────────────────────
// These calls are Hindi / English / Hinglish code-switching over a phone line,
// which is the case whisper-1 handles worst. gpt-4o-transcribe is markedly
// better on exactly that.
//
// The trade is real and worth stating plainly: gpt-4o-transcribe returns TEXT
// ONLY. It does not support response_format: "verbose_json", so there are no
// segment timestamps and an uploaded recording renders as a plain scrollable
// transcript rather than the timestamped turn-by-turn bubbles an AI call gets.
// Setting INTENT_TRANSCRIBE_MODEL=whisper-1 buys those timestamps back at a
// real cost in accuracy. Transcription quality won because the transcript feeds
// the SCORING ENGINE — a mis-heard "haan theek hai" changes the band, whereas a
// missing timestamp only changes how the transcript looks.

import { getOpenAI } from "@/lib/ai/invoices/client";

/**
 * Model used for call transcription. Overridable via env so an operator can
 * switch to whisper-1 for segment timestamps without a deploy.
 */
export const TRANSCRIBE_MODEL =
  process.env.INTENT_TRANSCRIBE_MODEL || "gpt-4o-transcribe";

/** Models that can return timestamped segments (verbose_json). */
const SEGMENT_CAPABLE = new Set(["whisper-1"]);

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export type TranscribeResult =
  | {
      status: "ok";
      text: string;
      segments: TranscriptSegment[] | null;
      language: string | null;
      model: string;
    }
  | { status: "failed"; reason: string; retryable: boolean };

/**
 * Errors that will fail again on the next attempt no matter how long we wait.
 * Retrying these just burns the attempt counter and delays the reviewer seeing
 * a real error message.
 */
function isPermanent(status: number | undefined): boolean {
  if (status == null) return false;
  // 400 malformed/unreadable audio, 401/403 bad key, 404 bad model,
  // 413 too large, 415 unsupported container, 422 unprocessable.
  return [400, 401, 403, 404, 413, 415, 422].includes(status);
}

/**
 * Transcribe one audio buffer.
 *
 * Takes a Buffer rather than a stream: the file has already been read out of S3
 * in full by the caller (the OpenAI SDK needs a File/Blob with a known size
 * anyway), and at a hard 25 MB ceiling the memory cost is bounded and small.
 *
 * Never throws — returns a discriminated result so the queue can distinguish
 * "retry this" from "tell the reviewer it will never work", which is the whole
 * difference between a self-healing job and one that spins forever.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  contentType: string,
): Promise<TranscribeResult> {
  const model = TRANSCRIBE_MODEL;

  try {
    const client = getOpenAI();

    // The SDK wants a web File. Node 18+ has one globally; constructing it from
    // the buffer keeps the declared name and type, which is how the API sniffs
    // the container.
    const file = new File([new Uint8Array(audio)], filename, {
      type: contentType,
    });

    const wantsSegments = SEGMENT_CAPABLE.has(model);

    const res = await client.audio.transcriptions.create({
      file,
      model,
      // Intentionally NOT passing `language`. These calls switch between Hindi,
      // English and Hinglish mid-sentence; pinning a language makes the model
      // force everything into it and mangles the half that isn't. Auto-detect
      // handles code-switching better than a wrong hint.
      ...(wantsSegments
        ? { response_format: "verbose_json" as const }
        : { response_format: "json" as const }),
    });

    const text = ((res as { text?: string }).text ?? "").trim();
    if (!text) {
      return {
        status: "failed",
        reason: "The recording produced no speech — it may be silent or corrupt.",
        retryable: false,
      };
    }

    const rawSegments = (
      res as { segments?: { start: number; end: number; text: string }[] }
    ).segments;

    return {
      status: "ok",
      text,
      segments: rawSegments?.length
        ? rawSegments.map((s) => ({
            start: s.start,
            end: s.end,
            text: (s.text ?? "").trim(),
          }))
        : null,
      language: (res as { language?: string }).language ?? null,
      model,
    };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message =
      (err as { message?: string })?.message ?? "Transcription failed.";

    return {
      status: "failed",
      reason: `${model}: ${message}`,
      retryable: !isPermanent(status),
    };
  }
}
