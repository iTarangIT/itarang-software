// GET /api/ai-dialer/recording/[callId]
//
// Self-healing recording link for a placed call. The campaign transcript drawer
// points its <audio> here whenever ai_call_logs.recording_url is still empty —
// which is the NORMAL state for ElevenLabs calls. Unlike Bolna, ElevenLabs never
// hands back a hosted recording URL on its webhook; the audio is only available
// from an authenticated ElevenLabs endpoint, so the browser cannot fetch it
// directly and nothing was ever stored.
//
// On hit:
//   - call already has a stored recording_url → 302 redirect to it (Bolna, or an
//     ElevenLabs call we've already re-hosted).
//   - ElevenLabs call with no URL yet → pull the audio, re-host it to the public
//     bucket, BACKFILL ai_call_logs.recording_url so we only do it once, then
//     302 redirect.
//   - otherwise (audio not ready yet / no API key / unknown call) → 404, and the
//     drawer player shows "Recording unavailable".
//
// The redirect target is the same public Supabase URL the drawer would have
// gotten directly, so this adds no new exposure — it just lazily produces that
// URL the first time someone opens/plays an older ElevenLabs recording.

import { db } from "@/lib/db";
import { aiCallLogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { rehostElevenLabsRecording } from "@/lib/ai/storage/recordingStore";

function redirectTo(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ callId: string }> },
) {
  const { callId } = await ctx.params;
  if (!callId) {
    return new Response("callId required", { status: 400 });
  }

  const rows = await db
    .select({
      recordingUrl: aiCallLogs.recording_url,
      provider: aiCallLogs.provider,
    })
    .from(aiCallLogs)
    .where(eq(aiCallLogs.call_id, callId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return new Response("Call not found", { status: 404 });
  }

  // Already have a playable URL — hand it straight back.
  if (row.recordingUrl) {
    return redirectTo(row.recordingUrl);
  }

  // ElevenLabs: the audio lives behind an authenticated endpoint (call_id IS the
  // conversation id). Pull + re-host to the public bucket. Returns "" if the
  // audio isn't ready yet or the key is missing.
  let playable = "";
  if (row.provider === "elevenlabs") {
    playable = await rehostElevenLabsRecording(callId);
  }

  if (!playable) {
    return new Response("Recording unavailable", { status: 404 });
  }

  // Lazy backfill so subsequent loads skip the re-host entirely and the Details
  // tab + the drawer player can use the URL directly next time.
  try {
    await db
      .update(aiCallLogs)
      .set({ recording_url: playable, updated_at: new Date() })
      .where(eq(aiCallLogs.call_id, callId));
  } catch (err) {
    // Backfill is best-effort — the redirect below still works this time.
    console.error("[ai-dialer:recording] backfill failed for", callId, err);
  }

  return redirectTo(playable);
}
