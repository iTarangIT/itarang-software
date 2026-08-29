// Validation rules and key derivation for attached call recordings.
//
// A sibling of src/lib/buyback/upload.ts rather than a widening of it. That
// module's ALLOWED_UPLOAD_TYPES is keyed by buyback evidence kinds
// (photo | id_proof | purchase_proof | invoice_pdf) and is reached through
// buyback ownership helpers; adding audio there would mean either a buyback
// "kind" that has nothing to do with buyback, or a shared map whose two halves
// are enforced by two different auth paths. Same shape, separate file.

import { extname } from "node:path";

/**
 * 25 MB, and this number is NOT arbitrary padding like the buyback route's.
 *
 * OpenAI's transcription endpoint hard-rejects any file above 25 MB. Accepting
 * a larger upload would mean storing bytes that can never be transcribed —
 * the reviewer would see it land, then watch it fail, with the real reason
 * buried in an API error. Refusing it at the door with a message that says why
 * is the honest behaviour.
 *
 * For scale: ~50 minutes of 64 kbps m4a, which is longer than any dealer call
 * in this corpus. If that ever binds, the fix is chunked transcription, not a
 * bigger cap.
 */
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

/**
 * Content types the transcriber can actually read.
 *
 * Browsers and phones are inconsistent about audio MIME types — the same m4a
 * arrives as audio/mp4, audio/x-m4a or audio/m4a depending on the OS and the
 * upload widget — so the list is deliberately generous about aliases while
 * still refusing anything that is not audio.
 */
export const ALLOWED_AUDIO_TYPES: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/x-aac": ".aac",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
};

/** What a recording is FOR — decides whether it gets transcribed at all. */
export const RECORDING_PURPOSES = [
  // A follow-up the user recorded on their own phone. Transcribed and scored
  // through the SAME analyzeTranscript() the dialer uses, so a human call and
  // an AI call are graded identically.
  "human_call",
  // The provider transcript was garbled or empty. Re-transcribe the stored
  // audio rather than trusting the provider's text.
  "ai_reanalysis",
  // Proof behind a correction. Stored and playable, never transcribed.
  "evidence",
] as const;
export type RecordingPurpose = (typeof RECORDING_PURPOSES)[number];

/** Purposes whose audio goes through speech-to-text. */
export function isTranscribable(purpose: RecordingPurpose): boolean {
  return purpose !== "evidence";
}

export class AudioUploadError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "AudioUploadError";
  }
}

/**
 * Resolve a file extension, preferring the declared MIME type and falling back
 * to the filename.
 *
 * The fallback matters: some Android share-sheets post audio as
 * `application/octet-stream`, and rejecting those would block a real and common
 * upload path. Accepting them on a recognised extension is the pragmatic call —
 * the transcriber sniffs the container itself and will fail loudly on a file
 * that is not really audio.
 */
export function audioExtensionFor(
  contentType: string | null | undefined,
  filename?: string | null,
): string {
  const byType = ALLOWED_AUDIO_TYPES[(contentType ?? "").toLowerCase()];
  if (byType) return byType;

  const ext = extname(filename ?? "").toLowerCase();
  if (Object.values(ALLOWED_AUDIO_TYPES).includes(ext)) return ext;

  return "";
}

/**
 * The reverse of audioExtensionFor: a content type for an object we already
 * stored, derived from its key.
 *
 * Needed when audio is read straight out of S3 rather than over HTTP — there is
 * no Content-Type header to copy in that path, and handing the transcriber
 * "application/octet-stream" costs it the container hint it uses to pick a
 * decoder.
 */
export function audioContentTypeFor(pathOrKey: string | null | undefined): string {
  const ext = extname(pathOrKey ?? "").toLowerCase();
  for (const [type, e] of Object.entries(ALLOWED_AUDIO_TYPES)) {
    if (e === ext) return type;
  }
  return "audio/mpeg";
}

/**
 * Throw unless this looks like audio the transcriber can read.
 */
export function assertAudioUpload(
  contentType: string | null | undefined,
  filename: string | null | undefined,
  sizeBytes: number,
): string {
  const ext = audioExtensionFor(contentType, filename);
  if (!ext) {
    throw new AudioUploadError(
      `"${contentType || "unknown"}" is not an audio format this can transcribe. ` +
        `Upload mp3, m4a, wav, webm, ogg or flac.`,
    );
  }

  if (sizeBytes > MAX_RECORDING_BYTES) {
    throw new AudioUploadError(
      `The recording is too large (${Math.round(sizeBytes / 1024 / 1024)} MB). ` +
        `Maximum is ${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)} MB, because the ` +
        `transcription service refuses anything bigger. Compress it or split it.`,
    );
  }

  return ext;
}

/**
 * The logical bucket. Already an allowed AND auth-required bucket in
 * /api/files/[bucket]/[...path], so uploaded recordings are servable and
 * access-controlled with no new route — the same bucket rehostRecording() uses
 * for provider audio.
 */
export const RECORDINGS_BUCKET = "call-recordings";

/**
 * Server-derived key. NEVER trust a client-supplied path — the filename is
 * carried in a column for display instead, so a crafted name cannot escape the
 * prefix or overwrite another lead's audio.
 */
export function recordingKeyFor(
  leadId: string,
  recordingId: string,
  ext: string,
): string {
  const safeLead = leadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `attached/${safeLead}/${recordingId}${ext}`;
}
