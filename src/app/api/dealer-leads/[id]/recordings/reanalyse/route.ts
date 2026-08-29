// POST /api/dealer-leads/[id]/recordings/reanalyse — re-read an AI call from
// its own audio.
//
// WHY THIS EXISTS
//   The band is only ever as good as the transcript it was extracted from, and
//   the provider's transcript is not always usable. Bolna returns speech-to-text
//   that can arrive garbled, truncated, or empty on a noisy line — and the
//   scoring engine faithfully turns a garbled transcript into a confident wrong
//   band. Today a reviewer who can hear the dealer clearly say "60V 100Ah, main
//   30 set karta hoon" has no way to tell the system that; they can only
//   override the final label, which teaches the model nothing about WHY it was
//   wrong (the reading, not the rule).
//
//   This route re-transcribes the stored audio with our own STT and re-extracts
//   the signals from that. The result is a second, independently-derived opinion
//   attached to the same call.
//
// WHAT IT DOES NOT DO
//   It does not overwrite ai_call_logs. The re-analysis lands as its own
//   lead_call_recordings row with its own band, shown next to the AI's original,
//   and a human decides which is right. Silently rewriting the call record would
//   destroy the very disagreement the eval harness measures.

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { INTENT_REVIEW_ROLES } from "@/lib/leads/access";
import {
  filesProxyPath,
  getObject,
  parseFilesProxyRef,
  putObject,
} from "@/lib/storage/s3";
import { rehostElevenLabsRecording } from "@/lib/ai/storage/recordingStore";
import {
  MAX_RECORDING_BYTES,
  RECORDINGS_BUCKET,
  audioContentTypeFor,
  audioExtensionFor,
  recordingKeyFor,
} from "@/lib/ai/transcription/audioUpload";

export const runtime = "nodejs";

const Body = z.object({ callId: z.string().min(1) });

function rowsOf<T>(result: unknown): T[] {
  return (((result as { rows?: T[] }).rows ?? (result as T[])) || []) as T[];
}

export const POST = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...INTENT_REVIEW_ROLES]);
    const { id: leadId } = await ctx.params;
    const { callId } = Body.parse(await req.json());

    const calls = rowsOf<{ recording_url: string | null; provider: string | null }>(
      await db.execute(sql`
        SELECT recording_url, provider
          FROM ai_call_logs
         WHERE call_id = ${callId}
         ORDER BY created_at DESC
         LIMIT 1
      `),
    );
    if (calls.length === 0) {
      return errorResponse("No such call.", 404);
    }

    // ── RESOLVE the audio; do not just read a column ─────────────────────────
    //
    // recording_url being NULL is the NORMAL state for an ElevenLabs call, not
    // an error. ElevenLabs hands back no hosted URL on its webhook — the audio
    // sits behind an authenticated endpoint and nothing is stored until someone
    // plays it. On sandbox that is 275 of 293 calls; on production the great
    // majority too.
    //
    // So the first version of this route, which 404'd on a null column, refused
    // to re-analyse ~94% of calls whose audio is perfectly retrievable — while
    // the player rendered immediately above the button plays those same calls
    // fine, because /api/ai-dialer/recording/[callId] performs exactly this lazy
    // re-host on demand. "No audio to re-analyse" directly under a working
    // player is the kind of contradiction that gets a feature written off as
    // broken.
    //
    // Reusing that route's own function keeps the two paths in step: fetch from
    // the provider once, re-host into our bucket, backfill the column so every
    // later reader takes the fast path.
    let recordingUrl = calls[0].recording_url ?? null;
    if (!recordingUrl && calls[0].provider === "elevenlabs") {
      recordingUrl = (await rehostElevenLabsRecording(callId)) || null;

      if (recordingUrl) {
        // Best-effort, as the player route treats it: the re-host has already
        // succeeded, so a failed backfill costs one repeat next time rather
        // than this request.
        try {
          await db.execute(sql`
            UPDATE ai_call_logs
               SET recording_url = ${recordingUrl}, updated_at = now()
             WHERE call_id = ${callId}
          `);
        } catch (err) {
          console.error("[reanalyse] recording_url backfill failed", callId, err);
        }
      }
    }

    if (!recordingUrl) {
      return errorResponse(
        "The audio for this call could not be retrieved, so there is nothing to " +
          "re-analyse. Try playing it in the player above — if that is silent too, " +
          "the provider no longer has the recording.",
        404,
      );
    }

    // Refuse a duplicate that is already queued or running. Without this, an
    // impatient double-click bills two transcriptions of the same audio and
    // leaves two near-identical rows for the reviewer to reconcile.
    const inFlight = rowsOf<{ id: string }>(
      await db.execute(sql`
        SELECT id::text AS id
          FROM lead_call_recordings
         WHERE call_id = ${callId}
           AND purpose = 'ai_reanalysis'
           AND status IN ('pending', 'running')
         LIMIT 1
      `),
    );
    if (inFlight.length > 0) {
      return successResponse(
        { id: inFlight[0].id, status: "pending", alreadyQueued: true },
        200,
      );
    }

    // Pull the audio server-side. TWO sources, and they are not interchangeable:
    //
    //   · Our own /api/files/call-recordings/… proxy, which is where every
    //     re-hosted ElevenLabs recording lives. That route is in
    //     AUTH_REQUIRED_BUCKETS, and a fetch() from this server carries no
    //     session cookie — so asking our own front door for our own object
    //     returns 401. Read it out of S3 directly instead.
    //   · A provider or public-bucket URL (Bolna, legacy Supabase): an ordinary
    //     cross-origin fetch, which the reviewer's browser could not do itself.
    //
    // Getting this wrong is silent and total: every re-hosted recording would
    // fail with "could not be downloaded (HTTP 401)" and look like an outage.
    let audio: Buffer;
    let contentType: string;

    const stored = parseFilesProxyRef(recordingUrl);
    if (stored) {
      const bytes = await getObject(stored.bucket, stored.key);
      if (!bytes) {
        return errorResponse(
          "The stored recording could not be read back from storage.",
          502,
        );
      }
      audio = bytes;
      // No Content-Type header on this path — derive it from the key.
      contentType = audioContentTypeFor(stored.key);
    } else {
      let res: Response;
      try {
        res = await fetch(recordingUrl);
      } catch (err) {
        return errorResponse(
          `Could not reach the stored recording: ${
            err instanceof Error ? err.message : "network error"
          }`,
          502,
        );
      }
      if (!res.ok) {
        return errorResponse(
          `The stored recording could not be downloaded (HTTP ${res.status}).`,
          502,
        );
      }
      contentType = res.headers.get("content-type") || "audio/mpeg";
      audio = Buffer.from(await res.arrayBuffer());
    }

    // The same 25 MB ceiling the upload route enforces, and for the same
    // reason: above it the transcription service refuses the file, so storing a
    // copy would only produce a job that can never succeed.
    if (audio.byteLength > MAX_RECORDING_BYTES) {
      return errorResponse(
        `This recording is ${Math.round(audio.byteLength / 1024 / 1024)} MB, above the ` +
          `${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)} MB limit the transcription ` +
          `service accepts.`,
        413,
      );
    }
    if (audio.byteLength === 0) {
      return errorResponse("The stored recording is empty.", 422);
    }

    const recordingId = randomUUID();
    const ext = audioExtensionFor(contentType, recordingUrl) || ".mp3";
    const key = recordingKeyFor(leadId, recordingId, ext);

    await putObject(RECORDINGS_BUCKET, key, audio, contentType);

    await db.execute(sql`
      INSERT INTO lead_call_recordings
        (id, lead_id, call_id, purpose, s3_key, content_type, size_bytes,
         original_filename, status, uploaded_by)
      VALUES
        (${recordingId}::uuid, ${leadId}, ${callId}, 'ai_reanalysis', ${key},
         ${contentType}, ${audio.byteLength}, ${`${callId}${ext}`}, 'pending',
         ${user.id}::uuid)
    `);

    return successResponse(
      {
        id: recordingId,
        status: "pending",
        purpose: "ai_reanalysis",
        url: filesProxyPath(RECORDINGS_BUCKET, key),
        sizeBytes: audio.byteLength,
      },
      201,
    );
  },
);
