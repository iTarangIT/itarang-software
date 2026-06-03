// Re-host a provider call recording into our own PUBLIC Supabase Storage bucket.
//
// Why: the raw Bolna/ElevenLabs recording URL is not something a non-technical
// reviewer (with no provider account) can reliably click and play — it may sit
// behind the provider's API/domain or expire. We download the audio server-side
// and re-upload it to a public bucket, then hand out OUR permanent URL, which
// plays directly in any browser with no login.
//
// Used by the Bolna + ElevenLabs post-call pipelines, inside their existing
// fire-and-forget sheet-logging closures, so this never blocks or breaks call
// finalization. On any failure it falls back to the original provider URL so the
// review sheet still has a link.

import { supabaseAdmin } from "@/lib/supabase/admin";

// Public bucket — create once in the Supabase project (Storage → New bucket →
// Public). Service-role uploads bypass RLS; public objects are served at
// /storage/v1/object/public/<bucket>/<key> with no auth.
const BUCKET = "call-recordings";

const ELEVENLABS_BASE =
  process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";

// Optional per-environment key prefix so sandbox and production don't collide
// when they share one Supabase project. Leave unset if they use separate
// projects. Normalized to end with "/" when present.
function envPrefix(): string {
  const raw = (process.env.CALL_RECORDINGS_PREFIX ?? "").trim();
  if (!raw) return "";
  return raw.replace(/^\/+|\/+$/g, "") + "/";
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function extFor(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("wav")) return "wav";
  if (ct.includes("m4a") || ct.includes("mp4") || ct.includes("aac")) return "m4a";
  if (ct.includes("ogg")) return "ogg";
  return "mp3";
}

/**
 * Download `recordingUrl` and re-host it in the public `call-recordings` bucket.
 * Returns the public, browser-playable URL. Falls back to the original
 * `recordingUrl` on any failure, or "" when there is no recording to host.
 */
export async function rehostRecording(opts: {
  provider: string;
  callId: string;
  recordingUrl: string | null;
}): Promise<string> {
  const { provider, callId, recordingUrl } = opts;
  if (!recordingUrl) return "";

  try {
    // Both Bolna and ElevenLabs serve directly-fetchable HTTPS/S3 URLs — no
    // auth header is needed to download the bytes.
    const res = await fetch(recordingUrl);
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status}`);
    }

    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg";
    const ext = extFor(contentType);
    const buffer = Buffer.from(await res.arrayBuffer());
    const key = `${envPrefix()}${sanitize(provider)}/${sanitize(callId)}.${ext}`;

    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(key, buffer, { contentType, upsert: true });
    if (error) {
      throw new Error(`upload failed: ${error.message}`);
    }

    const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(key);
    const publicUrl = data?.publicUrl;
    if (!publicUrl) {
      throw new Error("getPublicUrl returned no url");
    }

    console.log(`[recordingStore] re-hosted ${provider} recording ${callId}`);
    return publicUrl;
  } catch (err) {
    // Never throw — fall back to the provider URL so the sheet still links
    // somewhere, and the call pipeline is unaffected.
    console.error(
      `[recordingStore] re-host failed for ${provider} ${callId}, using provider URL:`,
      err,
    );
    return recordingUrl;
  }
}

/**
 * Re-host an ElevenLabs conversation's audio.
 *
 * Unlike Bolna, ElevenLabs does NOT return a hosted recording URL on the
 * post-call transcription webhook or the conversation status JSON — the audio
 * is only available from a SEPARATE authenticated endpoint:
 *   GET /v1/convai/conversations/{conversation_id}/audio   (xi-api-key header)
 * which streams the raw audio bytes (not a URL). We pull those bytes and upload
 * them to the same public bucket, returning OUR permanent browser-playable URL.
 *
 * Returns "" on any failure (missing key, audio not ready yet, upload error) so
 * the review sheet simply has no link rather than breaking finalization. The
 * audio can lag the transcript by a few seconds after a call ends; a later
 * poll/backfill re-running finalize will pick it up.
 */
export async function rehostElevenLabsRecording(
  conversationId: string,
): Promise<string> {
  if (!conversationId) return "";

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.warn(
      "[recordingStore] ELEVENLABS_API_KEY not set — cannot fetch conversation audio",
    );
    return "";
  }

  const url = `${ELEVENLABS_BASE}/v1/convai/conversations/${encodeURIComponent(
    conversationId,
  )}/audio`;

  try {
    const res = await fetch(url, {
      headers: { "xi-api-key": apiKey, accept: "audio/mpeg" },
    });
    if (!res.ok) {
      throw new Error(`audio fetch failed: HTTP ${res.status}`);
    }

    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg";
    const ext = extFor(contentType);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new Error("audio endpoint returned 0 bytes (not ready yet?)");
    }

    const key = `${envPrefix()}elevenlabs/${sanitize(conversationId)}.${ext}`;
    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(key, buffer, { contentType, upsert: true });
    if (error) {
      throw new Error(`upload failed: ${error.message}`);
    }

    const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(key);
    const publicUrl = data?.publicUrl;
    if (!publicUrl) {
      throw new Error("getPublicUrl returned no url");
    }

    console.log(
      `[recordingStore] re-hosted ElevenLabs audio ${conversationId} (${buffer.byteLength} bytes)`,
    );
    return publicUrl;
  } catch (err) {
    console.error(
      `[recordingStore] ElevenLabs audio re-host failed for ${conversationId}:`,
      err,
    );
    return "";
  }
}
