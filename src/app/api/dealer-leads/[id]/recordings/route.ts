// POST/GET /api/dealer-leads/[id]/recordings — attach audio to a lead.
//
// The point of this route: "instead of requiring lengthy manual explanations,
// let the reviewer attach the call recording so the AI can transcribe, analyse
// and understand the conversation itself". An ASM who rang a dealer back on
// their own phone uploads the recording here, and it comes back scored by the
// SAME engine the dialer uses.
//
// ── WHY A SAME-ORIGIN MULTIPART POST AND NOT A PRESIGNED PUT ─────────────────
// A browser PUT straight to S3 is cross-origin, the bucket carries no CORS
// configuration, and the app's IAM user is not permitted to add one
// (s3:PutBucketCORS is denied). The preflight dies with a bare "Failed to
// fetch" before the request ever reaches AWS. So the bytes come here and the
// server writes them to S3 itself — exactly the reasoning, and the shape, of
// /api/buyback/uploads.
//
// ── WHY UPLOADING DOES NOT MOVE THE LEAD ─────────────────────────────────────
// The recording gets its own band once transcribed, and stops there. A human
// still has to accept it by submitting a correction. Audio one colleague
// uploaded must not silently re-route another's pipeline — attaching evidence
// and deciding what it means are two different acts, and only the second is an
// override.

import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { INTENT_REVIEW_ROLES } from "@/lib/leads/access";
import { filesProxyPath, putObjectStream } from "@/lib/storage/s3";
import {
  MAX_RECORDING_BYTES,
  RECORDINGS_BUCKET,
  RECORDING_PURPOSES,
  assertAudioUpload,
  isTranscribable,
  recordingKeyFor,
  type RecordingPurpose,
} from "@/lib/ai/transcription/audioUpload";

export const runtime = "nodejs";

const fieldsSchema = z.object({
  purpose: z.enum(RECORDING_PURPOSES).default("human_call"),
  // ai_call_logs.call_id, when this audio belongs to an existing AI call.
  callId: z.string().min(1).optional(),
});

function rowsOf<T>(result: unknown): T[] {
  return (((result as { rows?: T[] }).rows ?? (result as T[])) || []) as T[];
}

export const POST = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...INTENT_REVIEW_ROLES]);
    const { id: leadId } = await ctx.params;

    // Refuse an oversized body BEFORE parsing it.
    //
    // req.formData() below buffers the ENTIRE request into heap, and the
    // file.size check runs after that — so on its own it protects only the S3
    // bill, not this process. Sandbox and production are co-resident on one 8GB
    // VPS, so a large POST that OOMs the node takes both down.
    //
    // Content-Length is a HINT, not a guarantee: a chunked upload omits it and
    // a liar can understate it. This is a cheap early gate, not the guard — the
    // real one is file.size below. The residual exposure is a chunked or
    // under-declared body, which needs streaming multipart parsing to close and
    // Request.formData() does not do that. Stated rather than papered over.
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) {
      return errorResponse(
        `The recording is too large (${Math.round(declared / 1024 / 1024)} MB). ` +
          `Maximum is ${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)} MB.`,
        413,
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return errorResponse("No file in the upload.", 400);
    }

    const parsed = fieldsSchema.safeParse({
      purpose: form.get("purpose") ?? undefined,
      callId: form.get("callId") ?? undefined,
    });
    if (!parsed.success) {
      return errorResponse(parsed.error.issues[0]?.message ?? "Invalid fields.", 400);
    }
    const { purpose, callId } = parsed.data;

    // Throws AudioUploadError (400) on a non-audio type or an oversized file,
    // with a message that explains the 25 MB ceiling rather than just asserting
    // it.
    const ext = assertAudioUpload(file.type, file.name, file.size);

    // The lead must exist. Without this, a typo'd id silently creates an
    // orphaned recording that no screen will ever show.
    const leadRows = rowsOf<{ id: string }>(
      await db.execute(sql`SELECT id FROM dealer_leads WHERE id = ${leadId} LIMIT 1`),
    );
    if (leadRows.length === 0) {
      return errorResponse("Lead not found.", 404);
    }

    const recordingId = randomUUID();
    // Server-derived. The client's filename is kept in a column for display but
    // NEVER used to build the key, so a crafted name cannot escape the prefix or
    // overwrite another lead's audio.
    const key = recordingKeyFor(leadId, recordingId, ext);

    await putObjectStream(
      RECORDINGS_BUCKET,
      key,
      Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]),
      file.type || "application/octet-stream",
    );

    // 'evidence' is stored and playable but never transcribed, so it goes
    // straight to a terminal state rather than sitting in the queue forever
    // looking like work nobody is doing.
    const status = isTranscribable(purpose as RecordingPurpose) ? "pending" : "skipped";

    await db.execute(sql`
      INSERT INTO lead_call_recordings
        (id, lead_id, call_id, purpose, s3_key, content_type, size_bytes,
         original_filename, status, uploaded_by)
      VALUES
        (${recordingId}::uuid, ${leadId}, ${callId ?? null}, ${purpose}, ${key},
         ${file.type || null}, ${file.size}, ${file.name || null}, ${status},
         ${user.id}::uuid)
    `);

    return successResponse(
      {
        id: recordingId,
        purpose,
        status,
        url: filesProxyPath(RECORDINGS_BUCKET, key),
        filename: file.name || null,
        sizeBytes: file.size,
      },
      201,
    );
  },
);

interface RecordingRow {
  id: string;
  call_id: string | null;
  purpose: string;
  s3_key: string;
  content_type: string | null;
  size_bytes: string | number | null;
  original_filename: string | null;
  status: string;
  attempts: number;
  error: string | null;
  transcript: string | null;
  transcript_segments: unknown;
  language: string | null;
  band: string | null;
  intent_score: number | null;
  info_signals_count: number | null;
  score_breakdown: unknown;
  call_summary: string | null;
  created_at: string | Date;
  transcribed_at: string | Date | null;
  uploaded_by_name: string | null;
}

function iso(v: string | Date | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

export const GET = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole([...INTENT_REVIEW_ROLES]);
    const { id: leadId } = await ctx.params;

    // The transcript is large and the panel only renders it for the recording
    // the reviewer opened, so it is opt-in — the list stays small while a job
    // is polled every few seconds for its status.
    const includeTranscript =
      new URL(req.url).searchParams.get("include") === "transcript";

    const result = await db.execute(sql`
      SELECT r.id::text                AS id,
             r.call_id,
             r.purpose,
             r.s3_key,
             r.content_type,
             r.size_bytes,
             r.original_filename,
             r.status,
             r.attempts,
             r.error,
             ${includeTranscript ? sql`r.transcript` : sql`NULL::text`} AS transcript,
             ${includeTranscript ? sql`r.transcript_segments` : sql`NULL::jsonb`}
                                       AS transcript_segments,
             r.language,
             r.band,
             r.intent_score,
             r.info_signals_count,
             r.score_breakdown,
             r.call_summary,
             r.created_at,
             r.transcribed_at,
             u.name                    AS uploaded_by_name
        FROM lead_call_recordings r
        LEFT JOIN users u ON u.id = r.uploaded_by
       WHERE r.lead_id = ${leadId}
       ORDER BY r.created_at DESC
       LIMIT 50
    `);

    const recordings = rowsOf<RecordingRow>(result).map((r) => ({
      id: r.id,
      callId: r.call_id,
      purpose: r.purpose,
      // Built here rather than stored, so a bucket or proxy-path change does not
      // need a data migration over every historical row.
      url: filesProxyPath(RECORDINGS_BUCKET, r.s3_key),
      contentType: r.content_type,
      sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
      filename: r.original_filename,
      status: r.status,
      attempts: r.attempts,
      error: r.error,
      transcript: r.transcript,
      transcriptSegments: r.transcript_segments ?? null,
      language: r.language,
      band: r.band,
      intentScore: r.intent_score,
      infoSignalsCount: r.info_signals_count,
      scoreBreakdown: r.score_breakdown ?? null,
      summary: r.call_summary,
      createdAt: iso(r.created_at),
      transcribedAt: iso(r.transcribed_at),
      uploadedByName: r.uploaded_by_name,
    }));

    return successResponse({ recordings });
  },
);
