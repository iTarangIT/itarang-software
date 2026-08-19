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
import { filesProxyPath, putObject } from "@/lib/storage/s3";
import {
  MAX_RECORDING_BYTES,
  RECORDINGS_BUCKET,
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

    const calls = rowsOf<{ recording_url: string | null }>(
      await db.execute(sql`
        SELECT recording_url
          FROM ai_call_logs
         WHERE call_id = ${callId}
         ORDER BY created_at DESC
         LIMIT 1
      `),
    );

    const recordingUrl = calls[0]?.recording_url ?? null;
    if (!recordingUrl) {
      return errorResponse(
        "This call has no stored recording, so there is no audio to re-analyse.",
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

    // Pull the provider's audio server-side. The reviewer's browser cannot do
    // this — the provider URL is on another origin and may need credentials.
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

    const contentType = res.headers.get("content-type") || "audio/mpeg";
    const audio = Buffer.from(await res.arrayBuffer());

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
