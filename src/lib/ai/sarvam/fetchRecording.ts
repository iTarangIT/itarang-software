// Sarvam recordings sit behind the authenticated analytics API — the webhook
// carries no recording URL. Pull the WAV by interaction_id and re-host it in
// our call-recordings bucket.
//
// GET {base}/analytics/v1/{org_id}/{workspace_id}/{app_id}/recordings/{interaction_id}
// → WAV bytes, or 404 when the call has no recording.

import { SARVAM_API_BASE, readSarvamReadConfig } from "./config";
import { storeRecordingBytes } from "@/lib/ai/storage/recordingStore";

/** The Sarvam API URL for one interaction's recording (needs X-API-Key to fetch). */
export function sarvamRecordingApiUrl(interactionId: string): string | null {
  const cfg = readSarvamReadConfig();
  if (!cfg) return null;
  // interaction_id is "YYYYMMDD/<id>" — keep the slash, encode each segment.
  const path = interactionId
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${SARVAM_API_BASE}/analytics/v1/${encodeURIComponent(cfg.orgId)}/${encodeURIComponent(cfg.workspaceId)}/${encodeURIComponent(cfg.appId)}/recordings/${path}`;
}

/** Is this a Sarvam analytics recording URL (stored when the first re-host failed)? */
export function isSarvamRecordingApiUrl(url: string | null | undefined): boolean {
  return !!url && url.startsWith(`${SARVAM_API_BASE}/analytics/`) && url.includes("/recordings/");
}

/**
 * Download one recording and re-host it. Returns our playable URL, or "" when
 * there is no recording (404), no key, or the copy failed. Never throws.
 */
export async function rehostSarvamRecordingFromUrl(
  attemptId: string,
  apiUrl: string,
): Promise<string> {
  const cfg = readSarvamReadConfig();
  if (!cfg || !attemptId || !apiUrl) return "";
  try {
    const res = await fetch(apiUrl, {
      headers: { "X-API-Key": cfg.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return "";
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/wav";
    const buffer = Buffer.from(await res.arrayBuffer());
    const url = await storeRecordingBytes({
      provider: "sarvam",
      callId: attemptId,
      buffer,
      contentType: contentType.startsWith("audio/") ? contentType : "audio/wav",
    });
    console.log(`[sarvam:recording] re-hosted ${attemptId} (${buffer.byteLength} bytes)`);
    return url;
  } catch (err) {
    console.error(`[sarvam:recording] re-host failed for ${attemptId}:`, err);
    return "";
  }
}

/**
 * Webhook-time fetch. Returns the URL to store on ai_call_logs.recording_url:
 *   - our re-hosted copy when the download worked;
 *   - otherwise the Sarvam API URL, so the player route can retry later
 *     (the recording may not be ready the instant the call ends);
 *   - null when the call has no interaction id.
 */
export async function resolveSarvamRecording(
  attemptId: string,
  interactionId: string | null,
): Promise<string | null> {
  if (!interactionId) return null;
  const apiUrl = sarvamRecordingApiUrl(interactionId);
  if (!apiUrl) return null;
  const hosted = await rehostSarvamRecordingFromUrl(attemptId, apiUrl);
  return hosted || apiUrl;
}
